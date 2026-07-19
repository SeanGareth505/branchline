use crate::infrastructure::git_cli;
use crate::AppResult;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::command;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CherryPickInput {
    pub path: String,
    pub shas: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CherryPickPreviewCommit {
    pub sha: String,
    pub short_sha: String,
    pub subject: String,
    pub author: String,
    pub already_applied: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CherryPickPreviewOutput {
    pub commits: Vec<CherryPickPreviewCommit>,
    pub estimated_conflicts: bool,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CherryPickOutput {
    pub ok: bool,
    pub message: String,
    pub completed_shas: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RevertCommitInput {
    pub path: String,
    pub sha: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RevertCommitOutput {
    pub ok: bool,
    pub message: String,
    pub sha: Option<String>,
}

#[command]
pub fn cherry_pick_preview(input: CherryPickInput) -> AppResult<CherryPickPreviewOutput> {
    let path = PathBuf::from(&input.path);
    git_cli::ensure_repo(&path)?;
    let mut commits = Vec::new();
    let mut estimated_conflicts = false;

    for sha in &input.shas {
        let subject =
            git_cli::run_git(&path, &["log", "-1", "--pretty=%s", sha]).unwrap_or_default();
        let author =
            git_cli::run_git(&path, &["log", "-1", "--pretty=%an", sha]).unwrap_or_default();
        let short_sha =
            git_cli::run_git(&path, &["rev-parse", "--short", sha]).unwrap_or_else(|_| sha.clone());
        let (ok, _, _) =
            git_cli::run_git_allow_fail(&path, &["merge-base", "--is-ancestor", sha, "HEAD"]);
        let already_applied = ok;

        let (tree_ok, tree_out, _) =
            git_cli::run_git_allow_fail(&path, &["merge-tree", "--write-tree", "HEAD", sha]);
        if !tree_ok || tree_out.to_lowercase().contains("conflict") {
            estimated_conflicts = true;
        }

        commits.push(CherryPickPreviewCommit {
            sha: sha.clone(),
            short_sha,
            subject,
            author,
            already_applied,
        });
    }

    Ok(CherryPickPreviewOutput {
        commits,
        estimated_conflicts,
        message: if estimated_conflicts {
            "One or more commits may conflict".into()
        } else {
            "Looks clean to cherry-pick".into()
        },
    })
}

#[command]
pub fn cherry_pick(input: CherryPickInput) -> AppResult<CherryPickOutput> {
    let path = PathBuf::from(&input.path);
    git_cli::ensure_repo(&path)?;
    if input.shas.is_empty() {
        return Ok(CherryPickOutput {
            ok: false,
            message: "No commits provided".into(),
            completed_shas: vec![],
        });
    }
    let mut args = vec!["cherry-pick"];
    let sha_refs: Vec<&str> = input.shas.iter().map(|s| s.as_str()).collect();
    args.extend(sha_refs);
    match git_cli::run_git(&path, &args) {
        Ok(msg) => Ok(CherryPickOutput {
            ok: true,
            message: if msg.is_empty() {
                "Cherry-pick completed".into()
            } else {
                msg
            },
            completed_shas: input.shas,
        }),
        Err(e) => Ok(CherryPickOutput {
            ok: false,
            message: e.to_string(),
            completed_shas: vec![],
        }),
    }
}

#[command]
pub fn revert_commit(input: RevertCommitInput) -> AppResult<RevertCommitOutput> {
    let path = PathBuf::from(&input.path);
    git_cli::ensure_repo(&path)?;
    match git_cli::run_git(&path, &["revert", "--no-edit", &input.sha]) {
        Ok(msg) => {
            let sha = git_cli::run_git(&path, &["rev-parse", "HEAD"]).ok();
            Ok(RevertCommitOutput {
                ok: true,
                message: if msg.is_empty() {
                    "Revert completed".into()
                } else {
                    msg
                },
                sha,
            })
        }
        Err(e) => Ok(RevertCommitOutput {
            ok: false,
            message: e.to_string(),
            sha: None,
        }),
    }
}
