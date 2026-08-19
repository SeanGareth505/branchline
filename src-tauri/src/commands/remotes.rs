use crate::infrastructure::git_cli;
use crate::{run_blocking, AppResult};
use serde::{Deserialize, Serialize};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};
use tauri::{command, AppHandle};

use super::branch::{run_git_with_process_output, MutationOutput, RepoPathInput};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteInfo {
    pub name: String,
    pub fetch_url: String,
    pub push_url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddRemoteInput {
    pub path: String,
    pub name: String,
    pub url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoveRemoteInput {
    pub path: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PullInput {
    pub path: String,
    pub remote: Option<String>,
    pub rebase: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetRemoteUrlInput {
    pub path: String,
    pub name: String,
    pub url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeRemoteInput {
    pub path: String,
    pub url: Option<String>,
    pub remote: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeRemoteOutput {
    pub ok: bool,
    pub url: String,
    pub protocol: String,
    pub message: String,
}

#[command]
pub async fn list_remotes(input: RepoPathInput) -> AppResult<Vec<RemoteInfo>> {
    run_blocking(move || {
        let path = PathBuf::from(&input.path);
        git_cli::ensure_repo(&path)?;
        let (ok, out, _) = git_cli::run_git_allow_fail(&path, &["remote", "-v"]);
        if !ok || out.trim().is_empty() {
            return Ok(vec![]);
        }

        let mut map: std::collections::BTreeMap<String, RemoteInfo> = std::collections::BTreeMap::new();
        for line in out.lines() {
            let parts: Vec<&str> = line.split_whitespace().collect();
            if parts.len() < 3 {
                continue;
            }
            let name = parts[0].to_string();
            let url = parts[1].to_string();
            let kind = parts[2].trim_matches(|c| c == '(' || c == ')');
            let entry = map.entry(name.clone()).or_insert(RemoteInfo {
                name,
                fetch_url: String::new(),
                push_url: String::new(),
            });
            if kind == "fetch" {
                entry.fetch_url = url;
            } else if kind == "push" {
                entry.push_url = url;
            }
        }
        Ok(map.into_values().collect())
    })
    .await
}

#[command]
pub fn add_remote(input: AddRemoteInput) -> AppResult<MutationOutput> {
    let path = PathBuf::from(&input.path);
    git_cli::ensure_repo(&path)?;
    let name = input.name.trim();
    let url = input.url.trim();
    if name.is_empty() || url.is_empty() {
        return Ok(MutationOutput {
            ok: false,
            message: "Remote name and URL are required".into(),
        });
    }
    git_cli::run_git(&path, &["remote", "add", name, url])?;
    Ok(MutationOutput {
        ok: true,
        message: format!("Added remote {name}"),
    })
}

#[command]
pub fn remove_remote(input: RemoveRemoteInput) -> AppResult<MutationOutput> {
    let path = PathBuf::from(&input.path);
    git_cli::ensure_repo(&path)?;
    git_cli::run_git(&path, &["remote", "remove", &input.name])?;
    Ok(MutationOutput {
        ok: true,
        message: format!("Removed remote {}", input.name),
    })
}

#[command]
pub fn pull_with_options(app: AppHandle, input: PullInput) -> AppResult<MutationOutput> {
    git_cli::with_repo_lock(&PathBuf::from(&input.path), |path| {
        let rebase = input.rebase.unwrap_or(false);
        let args = git_cli::pull_args(input.remote.as_deref(), rebase);
        let refs: Vec<&str> = args.iter().map(String::as_str).collect();
        let result = run_git_with_process_output(&app, path, &refs, "pull");
        match result {
            Ok((stdout, stderr)) => {
                let out = git_cli::combine_git_output(&stdout, &stderr);
                Ok(MutationOutput {
                    ok: true,
                    message: if out.is_empty() {
                        if rebase {
                            "Pulled with rebase".into()
                        } else {
                            "Pulled".into()
                        }
                    } else {
                        out
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

#[command]
pub fn prune_remote(input: RemoveRemoteInput) -> AppResult<MutationOutput> {
    git_cli::with_repo_lock(&PathBuf::from(&input.path), |path| {
        let name = input.name.trim();
        if name.is_empty() {
            return Ok(MutationOutput {
                ok: false,
                message: "Remote name is required".into(),
            });
        }
        let out = git_cli::run_git(path, &["remote", "prune", name])?;
        Ok(MutationOutput {
            ok: true,
            message: if out.is_empty() {
                format!("Pruned stale remote-tracking branches for {name}")
            } else {
                out
            },
        })
    })
}

#[command]
pub fn set_remote_url(input: SetRemoteUrlInput) -> AppResult<MutationOutput> {
    let path = PathBuf::from(&input.path);
    git_cli::ensure_repo(&path)?;
    let name = input.name.trim();
    let url = input.url.trim();
    if name.is_empty() || url.is_empty() {
        return Ok(MutationOutput {
            ok: false,
            message: "Remote name and URL are required".into(),
        });
    }
    git_cli::run_git(&path, &["remote", "set-url", name, url])?;
    Ok(MutationOutput {
        ok: true,
        message: format!("Updated {name} to {url}"),
    })
}

#[command]
pub fn probe_remote(input: ProbeRemoteInput) -> AppResult<ProbeRemoteOutput> {
    let path = PathBuf::from(&input.path);
    git_cli::ensure_repo(&path)?;
    let url = resolve_probe_url(&path, input.url.as_deref(), input.remote.as_deref())?;
    if url.is_empty() {
        return Ok(ProbeRemoteOutput {
            ok: false,
            url,
            protocol: "other".into(),
            message: "No remote URL to test".into(),
        });
    }
    Ok(run_ls_remote(&path, &url))
}

pub(crate) fn resolve_probe_url(path: &Path, url: Option<&str>, remote: Option<&str>) -> AppResult<String> {
    let explicit = url.map(str::trim).filter(|v| !v.is_empty());
    if let Some(value) = explicit {
        return Ok(value.to_string());
    }
    let name = remote
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .unwrap_or("origin");
    let (ok, out, _) = git_cli::run_git_allow_fail(path, &["remote", "get-url", name]);
    if ok {
        Ok(out.trim().to_string())
    } else {
        Ok(String::new())
    }
}

fn remote_protocol(url: &str) -> &'static str {
    let raw = url.trim();
    if raw.to_ascii_lowercase().starts_with("git@") || raw.to_ascii_lowercase().starts_with("ssh://")
    {
        "ssh"
    } else if raw.to_ascii_lowercase().starts_with("http://")
        || raw.to_ascii_lowercase().starts_with("https://")
    {
        "https"
    } else {
        "other"
    }
}

pub(crate) fn run_ls_remote(path: &Path, url: &str) -> ProbeRemoteOutput {
    let protocol = remote_protocol(url).to_string();
    let bin = match git_cli::git_bin() {
        Ok(bin) => bin,
        Err(e) => {
            return ProbeRemoteOutput {
                ok: false,
                url: url.to_string(),
                protocol,
                message: e.to_string(),
            };
        }
    };

    let mut child = match Command::new(&bin)
        .args(["ls-remote", "--exit-code", url, "HEAD"])
        .current_dir(path)
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
    {
        Ok(child) => child,
        Err(e) => {
            return ProbeRemoteOutput {
                ok: false,
                url: url.to_string(),
                protocol,
                message: format!("Failed to run git: {e}"),
            };
        }
    };

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let out_handle = thread::spawn(move || {
        let mut buf = String::new();
        if let Some(mut reader) = stdout {
            let _ = reader.read_to_string(&mut buf);
        }
        buf
    });
    let err_handle = thread::spawn(move || {
        let mut buf = String::new();
        if let Some(mut reader) = stderr {
            let _ = reader.read_to_string(&mut buf);
        }
        buf
    });

    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let stdout = out_handle.join().unwrap_or_default();
                let stderr = err_handle.join().unwrap_or_default();
                let detail = if !stderr.trim().is_empty() {
                    stderr.trim().to_string()
                } else if !stdout.trim().is_empty() {
                    stdout.trim().to_string()
                } else if status.success() {
                    "Remote responded".into()
                } else {
                    "Git could not reach this remote".into()
                };
                return ProbeRemoteOutput {
                    ok: status.success(),
                    url: url.to_string(),
                    protocol,
                    message: detail,
                };
            }
            Ok(None) if Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                return ProbeRemoteOutput {
                    ok: false,
                    url: url.to_string(),
                    protocol,
                    message: "Timed out talking to the remote (20s). Check the network or credentials.".into(),
                };
            }
            Ok(None) => thread::sleep(Duration::from_millis(40)),
            Err(e) => {
                return ProbeRemoteOutput {
                    ok: false,
                    url: url.to_string(),
                    protocol,
                    message: format!("Failed to wait for git: {e}"),
                };
            }
        }
    }
}
