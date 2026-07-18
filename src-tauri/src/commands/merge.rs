use crate::infrastructure::git_cli;
use crate::AppResult;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::command;

use super::branch::MutationOutput;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeInput {
    pub path: String,
    pub branch: String,
    pub no_ff: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RebaseInput {
    pub path: String,
    pub onto: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoOnlyInput {
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResetInput {
    pub path: String,
    pub target: String,
    pub mode: String,
}

#[command]
pub fn merge_branch(input: MergeInput) -> AppResult<MutationOutput> {
    let path = PathBuf::from(&input.path);
    git_cli::ensure_repo(&path)?;
    let mut args = vec!["merge"];
    if input.no_ff.unwrap_or(false) {
        args.push("--no-ff");
    }
    args.push(&input.branch);
    match git_cli::run_git(&path, &args) {
        Ok(out) => Ok(MutationOutput {
            ok: true,
            message: if out.is_empty() {
                format!("Merged {}", input.branch)
            } else {
                out
            },
        }),
        Err(e) => {
            let msg = e.to_string();
            if msg.to_lowercase().contains("conflict") {
                Ok(MutationOutput {
                    ok: false,
                    message: format!("Merge conflicts — resolve files, then Continue. {msg}"),
                })
            } else {
                Err(e)
            }
        }
    }
}

#[command]
pub fn rebase_onto(input: RebaseInput) -> AppResult<MutationOutput> {
    let path = PathBuf::from(&input.path);
    git_cli::ensure_repo(&path)?;
    match git_cli::run_git(&path, &["rebase", &input.onto]) {
        Ok(out) => Ok(MutationOutput {
            ok: true,
            message: if out.is_empty() {
                format!("Rebased onto {}", input.onto)
            } else {
                out
            },
        }),
        Err(e) => {
            let msg = e.to_string();
            if msg.to_lowercase().contains("conflict") {
                Ok(MutationOutput {
                    ok: false,
                    message: format!("Rebase conflicts — resolve files, then Continue. {msg}"),
                })
            } else {
                Err(e)
            }
        }
    }
}

#[command]
pub fn abort_operation(input: RepoOnlyInput) -> AppResult<MutationOutput> {
    let path = PathBuf::from(&input.path);
    git_cli::ensure_repo(&path)?;

    let (has_merge, _, _) = git_cli::run_git_allow_fail(&path, &["rev-parse", "-q", "--verify", "MERGE_HEAD"]);
    if has_merge {
        let out = git_cli::run_git(&path, &["merge", "--abort"])?;
        return Ok(MutationOutput {
            ok: true,
            message: if out.is_empty() {
                "Merge aborted".into()
            } else {
                out
            },
        });
    }

    let (has_rebase, _, _) = git_cli::run_git_allow_fail(&path, &["rev-parse", "-q", "--verify", "REBASE_HEAD"]);
    let rebase_dir = path.join(".git/rebase-merge").exists() || path.join(".git/rebase-apply").exists();
    if has_rebase || rebase_dir {
        let out = git_cli::run_git(&path, &["rebase", "--abort"])?;
        return Ok(MutationOutput {
            ok: true,
            message: if out.is_empty() {
                "Rebase aborted".into()
            } else {
                out
            },
        });
    }

    let (has_cherry, _, _) =
        git_cli::run_git_allow_fail(&path, &["rev-parse", "-q", "--verify", "CHERRY_PICK_HEAD"]);
    if has_cherry {
        let out = git_cli::run_git(&path, &["cherry-pick", "--abort"])?;
        return Ok(MutationOutput {
            ok: true,
            message: if out.is_empty() {
                "Cherry-pick aborted".into()
            } else {
                out
            },
        });
    }

    Ok(MutationOutput {
        ok: false,
        message: "No merge, rebase, or cherry-pick in progress".into(),
    })
}

#[command]
pub fn continue_operation(input: RepoOnlyInput) -> AppResult<MutationOutput> {
    let path = PathBuf::from(&input.path);
    git_cli::ensure_repo(&path)?;

    let (_, unresolved, _) =
        git_cli::run_git_allow_fail(&path, &["diff", "--name-only", "--diff-filter=U"]);
    if !unresolved.trim().is_empty() {
        return Ok(MutationOutput {
            ok: false,
            message: "Resolve conflicted files and stage them before continuing".into(),
        });
    }

    let (has_cherry, _, _) =
        git_cli::run_git_allow_fail(&path, &["rev-parse", "-q", "--verify", "CHERRY_PICK_HEAD"]);
    if has_cherry {
        let out = git_cli::run_git(&path, &["cherry-pick", "--continue"])?;
        return Ok(MutationOutput {
            ok: true,
            message: if out.is_empty() {
                "Cherry-pick continued".into()
            } else {
                out
            },
        });
    }

    let (has_rebase, _, _) = git_cli::run_git_allow_fail(&path, &["rev-parse", "-q", "--verify", "REBASE_HEAD"]);
    let rebase_dir = path.join(".git/rebase-merge").exists() || path.join(".git/rebase-apply").exists();
    if has_rebase || rebase_dir {
        let out = git_cli::run_git(&path, &["rebase", "--continue"])?;
        return Ok(MutationOutput {
            ok: true,
            message: if out.is_empty() {
                "Rebase continued".into()
            } else {
                out
            },
        });
    }

    let (has_merge, _, _) = git_cli::run_git_allow_fail(&path, &["rev-parse", "-q", "--verify", "MERGE_HEAD"]);
    if has_merge {
        let out = git_cli::run_git(&path, &["commit", "--no-edit"])?;
        return Ok(MutationOutput {
            ok: true,
            message: if out.is_empty() {
                "Merge committed".into()
            } else {
                out
            },
        });
    }

    Ok(MutationOutput {
        ok: false,
        message: "No merge, rebase, or cherry-pick in progress".into(),
    })
}

#[command]
pub fn reset_to(input: ResetInput) -> AppResult<MutationOutput> {
    let path = PathBuf::from(&input.path);
    git_cli::ensure_repo(&path)?;
    let mode = match input.mode.as_str() {
        "soft" => "--soft",
        "mixed" => "--mixed",
        "hard" => "--hard",
        _ => {
            return Ok(MutationOutput {
                ok: false,
                message: "Reset mode must be soft, mixed, or hard".into(),
            });
        }
    };
    if mode == "--hard" {
        return Ok(MutationOutput {
            ok: false,
            message: "Use the safety dialog for hard reset".into(),
        });
    }
    git_cli::run_git(&path, &["reset", mode, &input.target])?;
    Ok(MutationOutput {
        ok: true,
        message: format!("Reset ({}) to {}", input.mode, &input.target[..7.min(input.target.len())]),
    })
}
