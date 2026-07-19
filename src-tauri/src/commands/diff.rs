use crate::infrastructure::git_cli;
use crate::AppResult;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::command;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffInput {
    pub path: String,
    pub pathspec: Option<String>,
    pub staged: Option<bool>,
    pub commit: Option<String>,
    pub compare_from: Option<String>,
    pub compare_to: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffFileEntry {
    pub path: String,
    pub status: String,
    pub additions: Option<i32>,
    pub deletions: Option<i32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffOutput {
    pub unified: String,
    pub files: Vec<DiffFileEntry>,
}

#[command]
pub fn get_diff(input: DiffInput) -> AppResult<DiffOutput> {
    let path = PathBuf::from(&input.path);
    git_cli::ensure_repo(&path)?;

    let mut args: Vec<String> = vec!["diff".into(), "--no-color".into()];
    let mut name_args: Vec<String> =
        vec!["diff".into(), "--name-status".into(), "--no-color".into()];

    if input.staged.unwrap_or(false) {
        args.push("--cached".into());
        name_args.push("--cached".into());
    }

    if let (Some(from), Some(to)) = (&input.compare_from, &input.compare_to) {
        args.push(from.clone());
        args.push(to.clone());
        name_args.push(from.clone());
        name_args.push(to.clone());
    } else if let Some(commit) = &input.commit {
        args.push(format!("{commit}^"));
        args.push(commit.clone());
        name_args.push(format!("{commit}^"));
        name_args.push(commit.clone());
    }

    if let Some(pathspec) = &input.pathspec {
        args.push("--".into());
        args.push(pathspec.clone());
        name_args.push("--".into());
        name_args.push(pathspec.clone());
    }

    let arg_refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    let name_refs: Vec<&str> = name_args.iter().map(|s| s.as_str()).collect();

    let unified = git_cli::run_git(&path, &arg_refs).unwrap_or_default();
    let names = git_cli::run_git(&path, &name_refs).unwrap_or_default();

    let mut files = Vec::new();
    for line in names.lines() {
        let mut parts = line.split_whitespace();
        let status = parts.next().unwrap_or("M").to_string();
        let file_path = parts.next().unwrap_or("").to_string();
        if file_path.is_empty() {
            continue;
        }
        files.push(DiffFileEntry {
            path: file_path,
            status,
            additions: None,
            deletions: None,
        });
    }

    Ok(DiffOutput { unified, files })
}
