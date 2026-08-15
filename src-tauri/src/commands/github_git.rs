use crate::commands::branch::MutationOutput;
use crate::infrastructure::git_cli;
use crate::AppResult;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use tauri::command;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubCliAccount {
    pub login: String,
    pub active: bool,
    pub ok: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubGitStatus {
    pub ssh_login: String,
    pub uses_gh_helper: bool,
    pub accounts: Vec<GithubCliAccount>,
    pub active_login: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetRepoRemoteProtocolInput {
    pub path: String,
    pub protocol: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SwitchGithubCliUserInput {
    pub login: String,
}

#[command]
pub fn github_git_status() -> AppResult<GithubGitStatus> {
    let accounts = gh_accounts();
    let active_login = accounts
        .iter()
        .find(|account| account.active)
        .map(|account| account.login.clone())
        .unwrap_or_default();
    Ok(GithubGitStatus {
        ssh_login: ssh_github_login(),
        uses_gh_helper: uses_gh_credential_helper(),
        accounts,
        active_login,
    })
}

#[command]
pub fn set_repo_remote_protocol(input: SetRepoRemoteProtocolInput) -> AppResult<MutationOutput> {
    let path = PathBuf::from(&input.path);
    git_cli::ensure_repo(&path)?;
    let want = input.protocol.trim().to_ascii_lowercase();
    if want != "https" && want != "ssh" {
        return Ok(MutationOutput {
            ok: false,
            message: "Protocol must be https or ssh".into(),
        });
    }
    let remotes = list_remote_urls(&path);
    let mut changed = 0;
    for (name, url) in remotes {
        let Some(next) = convert_github_remote(&url, &want) else {
            continue;
        };
        if next == url {
            continue;
        }
        git_cli::run_git(&path, &["remote", "set-url", &name, &next])?;
        changed += 1;
    }
    if changed == 0 {
        return Ok(MutationOutput {
            ok: true,
            message: format!("All GitHub remotes already use {want}"),
        });
    }
    Ok(MutationOutput {
        ok: true,
        message: if changed == 1 {
            format!("Switched 1 remote to {want}")
        } else {
            format!("Switched {changed} remotes to {want}")
        },
    })
}

#[command]
pub fn switch_github_cli_user(input: SwitchGithubCliUserInput) -> AppResult<MutationOutput> {
    let login = input.login.trim();
    if login.is_empty() {
        return Ok(MutationOutput {
            ok: false,
            message: "Pick a GitHub account".into(),
        });
    }
    let gh = match which::which("gh") {
        Ok(path) => path,
        Err(_) => {
            return Ok(MutationOutput {
                ok: false,
                message: "GitHub CLI (gh) is not installed".into(),
            });
        }
    };
    let output = Command::new(&gh)
        .args(["auth", "switch", "--hostname", "github.com", "--user", login])
        .stdin(Stdio::null())
        .output();
    match output {
        Ok(output) if output.status.success() => {
            let _ = Command::new(&gh)
                .args(["auth", "setup-git", "--hostname", "github.com"])
                .stdin(Stdio::null())
                .output();
            Ok(MutationOutput {
                ok: true,
                message: format!("GitHub CLI now uses {login} for HTTPS"),
            })
        }
        Ok(output) => {
            let stderr = String::from_utf8_lossy(&output.stderr);
            let stdout = String::from_utf8_lossy(&output.stdout);
            let detail = if !stderr.trim().is_empty() {
                stderr.trim().to_string()
            } else {
                stdout.trim().to_string()
            };
            Ok(MutationOutput {
                ok: false,
                message: if detail.is_empty() {
                    format!("Could not switch GitHub CLI to {login}")
                } else {
                    detail
                },
            })
        }
        Err(err) => Ok(MutationOutput {
            ok: false,
            message: format!("Could not run gh: {err}"),
        }),
    }
}

fn list_remote_urls(path: &Path) -> Vec<(String, String)> {
    let (ok, out, _) = git_cli::run_git_allow_fail(path, &["remote", "-v"]);
    if !ok {
        return vec![];
    }
    let mut seen = Vec::new();
    for line in out.lines() {
        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.len() < 2 {
            continue;
        }
        if !parts.get(2).is_none_or(|kind| kind.contains("fetch")) {
            continue;
        }
        let name = parts[0].to_string();
        if seen.iter().any(|(existing, _)| existing == &name) {
            continue;
        }
        seen.push((name, parts[1].to_string()));
    }
    seen
}

fn uses_gh_credential_helper() -> bool {
    let Ok(value) = git_cli::run_git_global(&["config", "--get-regexp", r"credential\..*helper"]) else {
        return false;
    };
    value.to_ascii_lowercase().contains("gh auth git-credential")
}

fn gh_accounts() -> Vec<GithubCliAccount> {
    let Ok(gh) = which::which("gh") else {
        return vec![];
    };
    let output = Command::new(gh)
        .args(["auth", "status"])
        .stdin(Stdio::null())
        .output();
    let Ok(output) = output else {
        return vec![];
    };
    let text = format!(
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    parse_gh_auth_status(&text)
}

fn ssh_github_login() -> String {
    let output = Command::new("ssh")
        .args([
            "-o",
            "BatchMode=yes",
            "-o",
            "ConnectTimeout=8",
            "-o",
            "StrictHostKeyChecking=accept-new",
            "-T",
            "git@github.com",
        ])
        .stdin(Stdio::null())
        .output();
    let Ok(output) = output else {
        return String::new();
    };
    let text = format!(
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    ssh_account(&text).unwrap_or_default()
}

fn ssh_account(text: &str) -> Option<String> {
    let hi = text.split("Hi ").nth(1)?;
    let name = hi.split(['!', ',', ' ']).next()?.trim();
    if name.is_empty() {
        None
    } else {
        Some(name.to_string())
    }
}

pub(crate) fn parse_gh_auth_status(text: &str) -> Vec<GithubCliAccount> {
    let mut accounts = Vec::new();
    let mut current: Option<GithubCliAccount> = None;
    for line in text.lines() {
        let trimmed = line.trim();
        if let Some(login) = account_from_status_line(trimmed) {
            if let Some(prev) = current.take() {
                accounts.push(prev);
            }
            current = Some(GithubCliAccount {
                login,
                active: false,
                ok: trimmed.to_ascii_lowercase().contains("logged in"),
            });
            continue;
        }
        if trimmed.to_ascii_lowercase().contains("active account:") {
            if let Some(account) = current.as_mut() {
                account.active = trimmed.to_ascii_lowercase().contains("true");
            }
        }
    }
    if let Some(account) = current {
        accounts.push(account);
    }
    accounts
}

fn account_from_status_line(line: &str) -> Option<String> {
    let marker = "account ";
    let idx = line.to_ascii_lowercase().find(marker)?;
    let rest = &line[idx + marker.len()..];
    let login = rest.split_whitespace().next()?.trim_matches(|c| c == '(' || c == ')');
    if login.is_empty() {
        None
    } else {
        Some(login.to_string())
    }
}

pub(crate) fn convert_github_remote(url: &str, protocol: &str) -> Option<String> {
    let (host, path) = github_host_path(url)?;
    if protocol == "https" {
        Some(format!("https://{host}/{path}.git"))
    } else {
        Some(format!("git@{host}:{path}.git"))
    }
}

fn github_host_path(url: &str) -> Option<(String, String)> {
    let raw = url.trim();
    let (host, path) = if let Some(rest) = raw.strip_prefix("git@") {
        let (host, path) = rest.split_once(':')?;
        (host.to_string(), path.to_string())
    } else if let Some(rest) = raw.strip_prefix("ssh://git@") {
        let rest = rest.trim_start_matches('/');
        let (host, path) = rest.split_once('/')?;
        let host = host.split(':').next()?.to_string();
        (host, path.to_string())
    } else {
        let rest = raw
            .trim_start_matches("https://")
            .trim_start_matches("http://");
        let (host, path) = rest.split_once('/')?;
        (host.to_string(), path.to_string())
    };
    let host = host.to_ascii_lowercase();
    if !host.contains("github.com") {
        return None;
    }
    let path = path.trim_end_matches('/').trim_end_matches(".git").to_string();
    if path.is_empty() {
        None
    } else {
        Some((host, path))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn converts_ssh_and_https_github_urls() {
        assert_eq!(
            convert_github_remote("git@github.com:Dis-Chem/dischem-web.git", "https").as_deref(),
            Some("https://github.com/Dis-Chem/dischem-web.git")
        );
        assert_eq!(
            convert_github_remote("https://github.com/Dis-Chem/dischem-sap-commerce.git", "ssh")
                .as_deref(),
            Some("git@github.com:Dis-Chem/dischem-sap-commerce.git")
        );
        assert_eq!(convert_github_remote("git@bitbucket.org:team/repo.git", "https"), None);
    }

    #[test]
    fn parses_multiple_gh_accounts() {
        let text = r#"
github.com
  ✓ Logged in to github.com account SeanNortjeBigly (keyring)
  - Active account: true
  X Failed to log in to github.com account SeanGareth505 (keyring)
  - Active account: false
"#;
        let accounts = parse_gh_auth_status(text);
        assert_eq!(accounts.len(), 2);
        assert_eq!(accounts[0].login, "SeanNortjeBigly");
        assert!(accounts[0].active);
        assert!(accounts[0].ok);
        assert_eq!(accounts[1].login, "SeanGareth505");
        assert!(!accounts[1].active);
        assert!(!accounts[1].ok);
    }
}
