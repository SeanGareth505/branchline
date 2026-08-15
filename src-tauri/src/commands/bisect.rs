use crate::commands::branch::{MutationOutput, RepoPathInput};
use crate::infrastructure::git_cli;
use crate::AppResult;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tauri::command;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BisectStatus {
    pub active: bool,
    pub current_sha: String,
    pub current_short_sha: String,
    pub terms: String,
    pub steps_left: Option<String>,
    pub log_tail: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BisectStartInput {
    pub path: String,
    #[serde(default)]
    pub bad_sha: String,
    #[serde(default)]
    pub good_sha: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BisectMarkInput {
    pub path: String,
    #[serde(default)]
    pub sha: String,
}

fn git_dir(path: &Path) -> Option<PathBuf> {
    let (ok, out, _) = git_cli::run_git_allow_fail(path, &["rev-parse", "--git-dir"]);
    if !ok {
        return None;
    }
    let gd = PathBuf::from(out.trim());
    if gd.is_absolute() {
        Some(gd)
    } else {
        Some(path.join(gd))
    }
}

fn is_active(path: &Path) -> bool {
    let Some(git_dir) = git_dir(path) else {
        return false;
    };
    git_dir.join("BISECT_LOG").exists() || git_dir.join("BISECT_START").exists()
}

fn short_sha(sha: &str) -> String {
    sha.chars().take(7).collect()
}

fn mutation(ok: bool, message: String) -> MutationOutput {
    MutationOutput { ok, message }
}

fn git_message(ok: bool, out: String, err: String) -> String {
    let detail = if !err.trim().is_empty() {
        err
    } else {
        out
    };
    let trimmed = detail.trim();
    if trimmed.is_empty() {
        if ok {
            "Done".into()
        } else {
            "git bisect failed".into()
        }
    } else {
        trimmed.to_string()
    }
}

fn status_inner(path: &Path) -> BisectStatus {
    if !is_active(path) {
        return BisectStatus {
            active: false,
            current_sha: String::new(),
            current_short_sha: String::new(),
            terms: String::new(),
            steps_left: None,
            log_tail: String::new(),
        };
    }
    let (ok, sha, _) = git_cli::run_git_allow_fail(path, &["rev-parse", "BISECT_HEAD"]);
    let sha = if ok {
        sha.trim().to_string()
    } else {
        git_cli::run_git_allow_fail(path, &["rev-parse", "HEAD"])
            .1
            .trim()
            .to_string()
    };
    let terms = git_cli::run_git_allow_fail(path, &["bisect", "terms"])
        .1
        .trim()
        .replace('\n', " · ");
    let log = git_cli::run_git_allow_fail(path, &["bisect", "log"]).1;
    let log_tail = log
        .lines()
        .rev()
        .filter(|line| !line.trim().is_empty())
        .take(4)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect::<Vec<_>>()
        .join("\n");
    let steps_left = log.lines().rev().find_map(|line| {
        let lower = line.to_ascii_lowercase();
        if lower.contains("revisions left") || lower.contains("first bad commit") {
            Some(line.trim().to_string())
        } else {
            None
        }
    });
    BisectStatus {
        active: true,
        current_short_sha: short_sha(&sha),
        current_sha: sha,
        terms,
        steps_left,
        log_tail,
    }
}

#[command]
pub fn get_bisect_status(input: RepoPathInput) -> AppResult<BisectStatus> {
    git_cli::with_repo_lock(&PathBuf::from(&input.path), |path| Ok(status_inner(path)))
}

#[command]
pub fn bisect_start(input: BisectStartInput) -> AppResult<MutationOutput> {
    git_cli::with_repo_lock(&PathBuf::from(&input.path), |path| {
        if is_active(path) {
            return Ok(mutation(
                false,
                "A bisect is already in progress. Reset it first.".into(),
            ));
        }
        let (ok, out, err) = git_cli::run_git_allow_fail(path, &["bisect", "start"]);
        if !ok {
            return Ok(mutation(false, git_message(false, out, err)));
        }
        let bad = input.bad_sha.trim();
        if !bad.is_empty() {
            let (ok, out, err) = git_cli::run_git_allow_fail(path, &["bisect", "bad", bad]);
            if !ok {
                let _ = git_cli::run_git_allow_fail(path, &["bisect", "reset"]);
                return Ok(mutation(false, git_message(false, out, err)));
            }
        }
        let good = input.good_sha.trim();
        if !good.is_empty() {
            let (ok, out, err) = git_cli::run_git_allow_fail(path, &["bisect", "good", good]);
            if !ok {
                return Ok(mutation(false, git_message(false, out, err)));
            }
            return Ok(mutation(true, git_message(true, out, err)));
        }
        Ok(mutation(
            true,
            if bad.is_empty() {
                "Bisect started. Mark a bad commit, then a known good commit.".into()
            } else {
                "Bisect started. Mark a known good commit to continue.".into()
            },
        ))
    })
}

#[command]
pub fn bisect_good(input: BisectMarkInput) -> AppResult<MutationOutput> {
    git_cli::with_repo_lock(&PathBuf::from(&input.path), |path| {
        let sha = input.sha.trim();
        let args = if sha.is_empty() {
            vec!["bisect", "good"]
        } else {
            vec!["bisect", "good", sha]
        };
        let (ok, out, err) = git_cli::run_git_allow_fail(path, &args);
        Ok(mutation(ok, git_message(ok, out, err)))
    })
}

#[command]
pub fn bisect_bad(input: BisectMarkInput) -> AppResult<MutationOutput> {
    git_cli::with_repo_lock(&PathBuf::from(&input.path), |path| {
        let sha = input.sha.trim();
        let args = if sha.is_empty() {
            vec!["bisect", "bad"]
        } else {
            vec!["bisect", "bad", sha]
        };
        let (ok, out, err) = git_cli::run_git_allow_fail(path, &args);
        Ok(mutation(ok, git_message(ok, out, err)))
    })
}

#[command]
pub fn bisect_skip(input: BisectMarkInput) -> AppResult<MutationOutput> {
    git_cli::with_repo_lock(&PathBuf::from(&input.path), |path| {
        let sha = input.sha.trim();
        let args = if sha.is_empty() {
            vec!["bisect", "skip"]
        } else {
            vec!["bisect", "skip", sha]
        };
        let (ok, out, err) = git_cli::run_git_allow_fail(path, &args);
        Ok(mutation(ok, git_message(ok, out, err)))
    })
}

#[command]
pub fn bisect_reset(input: RepoPathInput) -> AppResult<MutationOutput> {
    git_cli::with_repo_lock(&PathBuf::from(&input.path), |path| {
        let (ok, out, err) = git_cli::run_git_allow_fail(path, &["bisect", "reset"]);
        Ok(mutation(
            ok,
            if ok && out.trim().is_empty() && err.trim().is_empty() {
                "Bisect reset".into()
            } else {
                git_message(ok, out, err)
            },
        ))
    })
}
