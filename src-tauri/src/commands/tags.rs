use crate::infrastructure::git_cli;
use crate::AppResult;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::command;

use super::branch::{MutationOutput, RepoPathInput};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TagInfo {
    pub name: String,
    pub sha: String,
    pub short_sha: String,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateTagInput {
    pub path: String,
    pub name: String,
    pub target: Option<String>,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteTagInput {
    pub path: String,
    pub name: String,
}

#[command]
pub fn list_tags(input: RepoPathInput) -> AppResult<Vec<TagInfo>> {
    let path = PathBuf::from(&input.path);
    git_cli::ensure_repo(&path)?;
    let (ok, out, _) = git_cli::run_git_allow_fail(
        &path,
        &[
            "for-each-ref",
            "--sort=-creatordate",
            "--format=%(refname:short)|%(objectname)|%(objectname:short)|%(subject)",
            "refs/tags",
        ],
    );
    if !ok || out.trim().is_empty() {
        return Ok(vec![]);
    }
    let mut tags = Vec::new();
    for line in out.lines() {
        let parts: Vec<&str> = line.splitn(4, '|').collect();
        if parts.len() < 3 {
            continue;
        }
        tags.push(TagInfo {
            name: parts[0].trim().to_string(),
            sha: parts[1].trim().to_string(),
            short_sha: parts[2].trim().to_string(),
            message: parts.get(3).map(|s| s.trim().to_string()).filter(|s| !s.is_empty()),
        });
    }
    Ok(tags)
}

#[command]
pub fn create_tag(input: CreateTagInput) -> AppResult<MutationOutput> {
    let path = PathBuf::from(&input.path);
    git_cli::ensure_repo(&path)?;
    let name = input.name.trim();
    if name.is_empty() {
        return Ok(MutationOutput {
            ok: false,
            message: "Tag name is required".into(),
        });
    }
    let target = input.target.as_deref().unwrap_or("HEAD");
    if let Some(msg) = input.message.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        git_cli::run_git(&path, &["tag", "-a", name, "-m", msg, target])?;
    } else {
        git_cli::run_git(&path, &["tag", name, target])?;
    }
    Ok(MutationOutput {
        ok: true,
        message: format!("Created tag {name}"),
    })
}

#[command]
pub fn delete_tag(input: DeleteTagInput) -> AppResult<MutationOutput> {
    let path = PathBuf::from(&input.path);
    git_cli::ensure_repo(&path)?;
    git_cli::run_git(&path, &["tag", "-d", &input.name])?;
    Ok(MutationOutput {
        ok: true,
        message: format!("Deleted tag {}", input.name),
    })
}
