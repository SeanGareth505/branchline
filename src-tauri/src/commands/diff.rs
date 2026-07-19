use crate::infrastructure::git_cli;
use crate::AppResult;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
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

fn apply_range_args(args: &mut Vec<String>, input: &DiffInput) {
    if input.staged.unwrap_or(false) {
        args.push("--cached".into());
    }
    if let (Some(from), Some(to)) = (&input.compare_from, &input.compare_to) {
        args.push(from.clone());
        args.push(to.clone());
    } else if let Some(commit) = &input.commit {
        args.push(format!("{commit}^"));
        args.push(commit.clone());
    }
}

fn apply_pathspec(args: &mut Vec<String>, pathspec: &Option<String>) {
    if let Some(pathspec) = pathspec {
        args.push("--".into());
        args.push(pathspec.clone());
    }
}

fn parse_numstat(out: &str) -> HashMap<String, (Option<i32>, Option<i32>)> {
    let mut map = HashMap::new();
    for line in out.lines() {
        let mut parts = line.split('\t');
        let add_raw = parts.next().unwrap_or("-");
        let del_raw = parts.next().unwrap_or("-");
        let file_path = parts.next().unwrap_or("").to_string();
        if file_path.is_empty() {
            continue;
        }
        let additions = add_raw.parse::<i32>().ok();
        let deletions = del_raw.parse::<i32>().ok();
        map.insert(file_path, (additions, deletions));
    }
    map
}

#[command]
pub fn get_diff(input: DiffInput) -> AppResult<DiffOutput> {
    let path = PathBuf::from(&input.path);
    git_cli::ensure_repo(&path)?;

    let mut args: Vec<String> = vec!["diff".into(), "--no-color".into()];
    let mut name_args: Vec<String> =
        vec!["diff".into(), "--name-status".into(), "--no-color".into()];
    let mut num_args: Vec<String> = vec!["diff".into(), "--numstat".into(), "--no-color".into()];

    apply_range_args(&mut args, &input);
    apply_range_args(&mut name_args, &input);
    apply_range_args(&mut num_args, &input);
    apply_pathspec(&mut args, &input.pathspec);
    apply_pathspec(&mut name_args, &input.pathspec);
    apply_pathspec(&mut num_args, &input.pathspec);

    let arg_refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    let name_refs: Vec<&str> = name_args.iter().map(|s| s.as_str()).collect();
    let num_refs: Vec<&str> = num_args.iter().map(|s| s.as_str()).collect();

    const MAX_DIFF_BYTES: usize = 2 * 1024 * 1024;
    let mut unified = git_cli::run_git(&path, &arg_refs).unwrap_or_default();
    if unified.len() > MAX_DIFF_BYTES {
        let mut truncated = unified;
        truncated.truncate(MAX_DIFF_BYTES);
        if let Some(idx) = truncated.rfind('\n') {
            truncated.truncate(idx);
        }
        truncated.push_str(
            "\n\n… diff truncated — select a single file to view the full patch safely",
        );
        unified = truncated;
    }
    let names = git_cli::run_git(&path, &name_refs).unwrap_or_default();
    let stats = parse_numstat(&git_cli::run_git(&path, &num_refs).unwrap_or_default());

    let mut files = Vec::new();
    for line in names.lines() {
        if files.len() >= 2_000 {
            break;
        }
        let mut parts = line.split_whitespace();
        let status = parts.next().unwrap_or("M").to_string();
        let file_path = parts.next().unwrap_or("").to_string();
        if file_path.is_empty() {
            continue;
        }
        let (additions, deletions) = stats
            .get(&file_path)
            .copied()
            .unwrap_or((None, None));
        files.push(DiffFileEntry {
            path: file_path,
            status,
            additions,
            deletions,
        });
    }

    Ok(DiffOutput { unified, files })
}
