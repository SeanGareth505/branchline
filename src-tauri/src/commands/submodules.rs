use crate::infrastructure::git_cli;
use crate::AppResult;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::PathBuf;
use tauri::command;

use super::branch::{MutationOutput, RepoPathInput};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubmoduleInfo {
    pub name: String,
    pub path: String,
    pub url: String,
    pub head: String,
    pub short_head: String,
    pub status: String,
    pub initialized: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubmodulePathInput {
    pub path: String,
    pub submodule_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LfsFileInfo {
    pub path: String,
    pub locked: bool,
    pub size: String,
}

fn short_sha(sha: &str) -> String {
    sha.chars().take(7).collect()
}

#[command]
pub fn list_submodules(input: RepoPathInput) -> AppResult<Vec<SubmoduleInfo>> {
    git_cli::with_repo_lock(&PathBuf::from(&input.path), |path| {
        let (ok, out, _) = git_cli::run_git_allow_fail(path, &["submodule", "status", "--recursive"]);
        if !ok && out.trim().is_empty() {
            return Ok(vec![]);
        }

        let mut entries = Vec::new();
        for line in out.lines() {
            let raw = line.trim_end();
            if raw.is_empty() {
                continue;
            }
            let status_ch = raw.chars().next().unwrap_or(' ');
            let rest = if matches!(status_ch, '-' | '+' | 'U' | ' ') {
                raw[status_ch.len_utf8()..].trim_start()
            } else {
                raw
            };
            let mut parts = rest.split_whitespace();
            let Some(sha) = parts.next() else {
                continue;
            };
            let Some(sub_path) = parts.next() else {
                continue;
            };
            let name = sub_path.rsplit('/').next().unwrap_or(sub_path).to_string();
            let status = match status_ch {
                '-' => "uninitialized",
                '+' => "modified",
                'U' => "conflict",
                _ => "ok",
            }
            .to_string();
            let url = git_cli::run_git_allow_fail(
                path,
                &["config", "-f", ".gitmodules", &format!("submodule.{sub_path}.url")],
            )
            .1
            .trim()
            .to_string();
            let url = if url.is_empty() {
                git_cli::run_git_allow_fail(
                    path,
                    &[
                        "config",
                        "-f",
                        ".gitmodules",
                        &format!("submodule.{name}.url"),
                    ],
                )
                .1
                .trim()
                .to_string()
            } else {
                url
            };
            entries.push(SubmoduleInfo {
                name,
                path: sub_path.to_string(),
                url,
                head: sha.trim_start_matches(['+', '-', 'U']).to_string(),
                short_head: short_sha(sha.trim_start_matches(['+', '-', 'U'])),
                status,
                initialized: status_ch != '-',
            });
        }
        Ok(entries)
    })
}

#[command]
pub fn update_submodules(input: RepoPathInput) -> AppResult<MutationOutput> {
    git_cli::with_repo_lock(&PathBuf::from(&input.path), |path| {
        match git_cli::run_git(path, &["submodule", "update", "--init", "--recursive"]) {
            Ok(out) => Ok(MutationOutput {
                ok: true,
                message: if out.trim().is_empty() {
                    "Submodules updated".into()
                } else {
                    out
                },
            }),
            Err(e) => Ok(MutationOutput {
                ok: false,
                message: e.to_string(),
            }),
        }
    })
}

#[command]
pub fn sync_submodules(input: RepoPathInput) -> AppResult<MutationOutput> {
    git_cli::with_repo_lock(&PathBuf::from(&input.path), |path| {
        match git_cli::run_git(path, &["submodule", "sync", "--recursive"]) {
            Ok(out) => Ok(MutationOutput {
                ok: true,
                message: if out.trim().is_empty() {
                    "Submodule URLs synced".into()
                } else {
                    out
                },
            }),
            Err(e) => Ok(MutationOutput {
                ok: false,
                message: e.to_string(),
            }),
        }
    })
}

#[command]
pub fn update_submodule(input: SubmodulePathInput) -> AppResult<MutationOutput> {
    git_cli::with_repo_lock(&PathBuf::from(&input.path), |path| {
        let sub = input.submodule_path.trim();
        if sub.is_empty() {
            return Ok(MutationOutput {
                ok: false,
                message: "Submodule path is required".into(),
            });
        }
        match git_cli::run_git(path, &["submodule", "update", "--init", "--", sub]) {
            Ok(out) => Ok(MutationOutput {
                ok: true,
                message: if out.trim().is_empty() {
                    format!("Updated submodule {sub}")
                } else {
                    out
                },
            }),
            Err(e) => Ok(MutationOutput {
                ok: false,
                message: e.to_string(),
            }),
        }
    })
}

#[command]
pub fn list_lfs_files(input: RepoPathInput) -> AppResult<Vec<LfsFileInfo>> {
    git_cli::with_repo_lock(&PathBuf::from(&input.path), |path| {
        let (ok, out, err) = git_cli::run_git_allow_fail(path, &["lfs", "ls-files", "-s"]);
        if !ok {
            let _ = (out, err);
            return Ok(vec![]);
        }
        let locked_paths = lfs_locked_paths(path);
        let mut entries = Vec::new();
        for line in out.lines() {
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            // oid *|- path (size)
            let mut path_part = line.to_string();
            let mut size = String::new();
            if let Some(idx) = line.rfind('(') {
                if line.ends_with(')') {
                    size = line[idx + 1..line.len() - 1].trim().to_string();
                    path_part = line[..idx].trim().to_string();
                }
            }
            let file_path = path_part
                .split_whitespace()
                .skip(1)
                .find(|p| *p != "*" && *p != "-")
                .unwrap_or("")
                .trim_start_matches(['*', '-'])
                .trim()
                .to_string();
            if file_path.is_empty() {
                continue;
            }
            let locked = locked_paths.contains(&file_path);
            entries.push(LfsFileInfo {
                path: file_path,
                locked,
                size,
            });
        }
        Ok(entries)
    })
}

fn lfs_locked_paths(repo: &std::path::Path) -> HashSet<String> {
    let (ok, out, _) = git_cli::run_git_allow_fail(repo, &["lfs", "locks", "--json"]);
    if !ok || out.trim().is_empty() {
        return HashSet::new();
    }
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&out) else {
        return HashSet::new();
    };
    let mut set = HashSet::new();
    if let Some(arr) = value.as_array() {
        for item in arr {
            if let Some(p) = item.get("path").and_then(|v| v.as_str()) {
                if !p.is_empty() {
                    set.insert(p.to_string());
                }
            }
        }
    }
    set
}

#[command]
pub fn lfs_pull(input: RepoPathInput) -> AppResult<MutationOutput> {
    git_cli::with_repo_lock(&PathBuf::from(&input.path), |path| {
        let (ok, out, err) = git_cli::run_git_allow_fail(path, &["lfs", "pull"]);
        if !ok {
            return Ok(MutationOutput {
                ok: false,
                message: if err.trim().is_empty() {
                    out
                } else {
                    err
                },
            });
        }
        Ok(MutationOutput {
            ok: true,
            message: if out.trim().is_empty() {
                "LFS objects pulled".into()
            } else {
                out
            },
        })
    })
}
