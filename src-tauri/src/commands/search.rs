use crate::infrastructure::git_cli;
use crate::{run_blocking, AppResult};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::command;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchRepoInput {
    pub path: String,
    pub query: String,
    #[serde(default)]
    pub max_results: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub path: String,
    pub line: Option<u32>,
    pub text: String,
    pub kind: String,
}

#[command]
pub async fn search_repo(input: SearchRepoInput) -> AppResult<Vec<SearchHit>> {
    run_blocking(move || search_repo_inner(input)).await
}

fn search_repo_inner(input: SearchRepoInput) -> AppResult<Vec<SearchHit>> {
    let query = input.query.trim();
    if query.chars().count() < 2 {
        return Ok(vec![]);
    }
    let max = input.max_results.unwrap_or(80).clamp(1, 200);
    let path = PathBuf::from(&input.path);
    git_cli::ensure_repo(&path)?;

    let mut hits = Vec::new();
    let needle = query.to_lowercase();
    let files = git_cli::run_git(&path, &["ls-files", "-z"])?;
    for file in files.split('\0') {
        let file = file.trim();
        if file.is_empty() {
            continue;
        }
        if file.to_lowercase().contains(&needle) {
            hits.push(SearchHit {
                path: file.to_string(),
                line: None,
                text: file.to_string(),
                kind: "file".into(),
            });
            if hits.len() >= max {
                return Ok(hits);
            }
        }
    }

    let remaining = max.saturating_sub(hits.len());
    if remaining == 0 {
        return Ok(hits);
    }

    let per_file = 3usize;
    let grep_max = remaining.saturating_mul(per_file).clamp(1, 400);
    let (ok, stdout, stderr) = git_cli::run_git_capture(
        &path,
        &[
            "grep",
            "-n",
            "-I",
            "-F",
            "-e",
            query,
            &format!("--max-count={per_file}"),
        ],
    )?;
    if !ok && stdout.trim().is_empty() {
        if !stderr.trim().is_empty() && !stderr.to_lowercase().contains("no such") {
            let lower = stderr.to_lowercase();
            if !lower.contains("exit code 1") && stderr.trim() != "error: no matches found" {
                if stderr.contains("fatal") {
                    return Err(crate::AppError::git(stderr.trim().to_string()));
                }
            }
        }
        return Ok(hits);
    }

    let mut content = 0usize;
    for raw in stdout.lines() {
        if content >= grep_max {
            break;
        }
        let Some((file, rest)) = raw.split_once(':') else {
            continue;
        };
        let (line_str, text) = rest.split_once(':').unwrap_or(("0", rest));
        let line = line_str.parse::<u32>().ok();
        hits.push(SearchHit {
            path: file.to_string(),
            line,
            text: text.trim().to_string(),
            kind: "content".into(),
        });
        content += 1;
        if hits.len() >= max {
            break;
        }
    }
    Ok(hits)
}
