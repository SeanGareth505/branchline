use crate::infrastructure::git2_repo::{self, ArtificialCommit, CommitInfo};
use crate::infrastructure::git_cli;
use crate::AppResult;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::command;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitLogInput {
    pub path: String,
    pub limit: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoPathInput {
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FilePathInput {
    pub path: String,
    pub file: String,
    #[serde(default)]
    pub commit: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BlameLine {
    pub line_number: usize,
    pub content: String,
    pub sha: String,
    pub author: String,
    pub email: String,
    pub timestamp: i64,
    pub summary: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileHistoryEntry {
    pub sha: String,
    pub short_sha: String,
    pub subject: String,
    pub author: String,
    pub timestamp: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitRangeInput {
    pub path: String,
    pub from: Option<String>,
    pub to: Option<String>,
    pub limit: Option<usize>,
}

#[command]
pub fn get_commit_log(input: CommitLogInput) -> AppResult<Vec<CommitInfo>> {
    let path = PathBuf::from(&input.path);
    let limit = input.limit.unwrap_or(200).clamp(1, 5000);
    git2_repo::commit_log(&path, limit)
}

#[command]
pub fn get_commit_range(input: CommitRangeInput) -> AppResult<Vec<CommitInfo>> {
    let path = PathBuf::from(&input.path);
    let limit = input.limit.unwrap_or(500).clamp(1, 5000);
    git_cli::with_repo_lock(&path, |resolved| {
        git2_repo::commit_range(resolved, input.from.as_deref(), input.to.as_deref(), limit)
    })
}

#[command]
pub fn get_artificial_commits(input: RepoPathInput) -> AppResult<Vec<ArtificialCommit>> {
    let path = PathBuf::from(&input.path);
    git2_repo::artificial_commits(&path)
}

#[command]
pub fn get_file_blame(input: FilePathInput) -> AppResult<Vec<BlameLine>> {
    use crate::infrastructure::git_cli;
    let path = PathBuf::from(&input.path);
    git_cli::ensure_repo(&path)?;
    let commit = input
        .commit
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let out = if let Some(sha) = commit {
        git_cli::run_git(
            &path,
            &["blame", "--line-porcelain", sha, "--", &input.file],
        )?
    } else {
        git_cli::run_git(&path, &["blame", "--line-porcelain", "--", &input.file])?
    };

    let mut lines = Vec::new();
    let mut current_sha = String::new();
    let mut author = String::new();
    let mut email = String::new();
    let mut timestamp = 0i64;
    let mut summary = String::new();
    let mut line_number = 0usize;

    for raw in out.lines() {
        if lines.len() >= 5_000 {
            break;
        }
        if raw.starts_with('\t') {
            line_number += 1;
            lines.push(BlameLine {
                line_number,
                content: raw[1..].to_string(),
                sha: current_sha.clone(),
                author: author.clone(),
                email: email.clone(),
                timestamp,
                summary: summary.clone(),
            });
        } else if let Some((sha, _)) = raw.split_once(' ') {
            if sha.len() >= 40 {
                current_sha = sha.to_string();
            }
        } else if let Some(rest) = raw.strip_prefix("author ") {
            author = rest.to_string();
        } else if let Some(rest) = raw.strip_prefix("author-mail ") {
            email = rest.trim_matches(|c| c == '<' || c == '>').to_string();
        } else if let Some(rest) = raw.strip_prefix("author-time ") {
            timestamp = rest.parse().unwrap_or(0);
        } else if let Some(rest) = raw.strip_prefix("summary ") {
            summary = rest.to_string();
        }
    }
    Ok(lines)
}

#[command]
pub fn get_file_history(input: FilePathInput) -> AppResult<Vec<FileHistoryEntry>> {
    use crate::infrastructure::git_cli;
    let path = PathBuf::from(&input.path);
    git_cli::ensure_repo(&path)?;
    let out = git_cli::run_git(
        &path,
        &[
            "log",
            "--follow",
            "--max-count=100",
            "--pretty=format:%H%x1f%h%x1f%s%x1f%an%x1f%at",
            "--",
            &input.file,
        ],
    )?;
    let mut entries = Vec::new();
    for line in out.lines() {
        let parts: Vec<&str> = line.split('\x1f').collect();
        if parts.len() < 5 {
            continue;
        }
        entries.push(FileHistoryEntry {
            sha: parts[0].to_string(),
            short_sha: parts[1].to_string(),
            subject: parts[2].to_string(),
            author: parts[3].to_string(),
            timestamp: parts[4].parse().unwrap_or(0),
        });
    }
    Ok(entries)
}
