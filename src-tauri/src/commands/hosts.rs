use crate::commands::settings::{load_settings_with_tokens, ConnectionConfig};
use crate::infrastructure::git_cli;
use crate::state::AppState;
use crate::{AppError, AppResult};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::command;
use tauri::State;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostRepository {
    pub id: String,
    pub name: String,
    pub full_name: String,
    pub clone_url: String,
    pub ssh_url: String,
    pub private: bool,
    pub provider: String,
    pub updated_at: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListHostReposInput {
    #[serde(default)]
    pub connection_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishToGithubInput {
    pub path: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub private: bool,
    #[serde(default = "default_remote_name")]
    pub remote_name: String,
    #[serde(default)]
    pub create_release_tag: bool,
    #[serde(default)]
    pub tag_name: String,
}

fn default_remote_name() -> String {
    "origin".into()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishToGithubOutput {
    pub ok: bool,
    pub message: String,
    pub full_name: String,
    pub html_url: String,
    pub clone_url: String,
    pub release_url: Option<String>,
    pub tag_name: Option<String>,
}

#[derive(Debug, Deserialize)]
struct GitHubRepo {
    id: u64,
    name: String,
    full_name: String,
    clone_url: String,
    ssh_url: String,
    html_url: Option<String>,
    private: bool,
    updated_at: Option<String>,
}

#[derive(Debug, Deserialize)]
struct GitHubUser {
    login: String,
}

#[derive(Debug, Deserialize)]
struct GitHubRelease {
    html_url: String,
}

#[derive(Debug, Deserialize)]
struct GitLabProject {
    id: u64,
    name: String,
    path_with_namespace: String,
    http_url_to_repo: String,
    ssh_url_to_repo: String,
    visibility: Option<String>,
    last_activity_at: Option<String>,
}

#[command]
pub fn list_host_repositories(
    state: State<'_, AppState>,
    input: Option<ListHostReposInput>,
) -> AppResult<Vec<HostRepository>> {
    let settings = load_settings_with_tokens(&state)?;
    let connection_id = input.and_then(|v| v.connection_id).filter(|s| !s.trim().is_empty());

    let connections: Vec<&ConnectionConfig> = settings
        .connections
        .iter()
        .filter(|c| {
            c.enabled
                && !c.token.trim().is_empty()
                && matches!(c.provider.as_str(), "github" | "gitlab" | "azureDevOps")
                && connection_id
                    .as_ref()
                    .map(|id| &c.id == id || &c.provider == id)
                    .unwrap_or(true)
        })
        .collect();

    if connections.is_empty() {
        return Err(AppError::msg(
            "No linked Git host. Enable GitHub or GitLab under Settings → Connections and paste a PAT.",
        ));
    }

    let mut out = Vec::new();
    for connection in connections {
        match connection.provider.as_str() {
            "github" => out.extend(fetch_github_repos(connection)?),
            "gitlab" => out.extend(fetch_gitlab_repos(connection)?),
            "azureDevOps" => {
                return Err(AppError::msg(
                    "Azure DevOps repo listing is not supported yet. Use GitHub or GitLab, or paste a clone URL.",
                ));
            }
            _ => {}
        }
    }

    out.sort_by(|a, b| {
        b.updated_at
            .cmp(&a.updated_at)
            .then_with(|| a.full_name.to_lowercase().cmp(&b.full_name.to_lowercase()))
    });
    Ok(out)
}

#[command]
pub fn publish_to_github(
    state: State<'_, AppState>,
    input: PublishToGithubInput,
) -> AppResult<PublishToGithubOutput> {
    let path = PathBuf::from(&input.path);
    git_cli::ensure_repo(&path)?;

    let name = sanitize_repo_name(&input.name)?;
    let remote_name = {
        let r = input.remote_name.trim();
        if r.is_empty() {
            "origin".to_string()
        } else {
            r.to_string()
        }
    };

    let connection = github_connection(&state)?;
    let token = connection.token.trim().to_string();
    let base = connection.base_url.trim().trim_end_matches('/');
    let client = reqwest::blocking::Client::new();

    let _user: GitHubUser = client
        .get(format!("{base}/user"))
        .header("Accept", "application/vnd.github+json")
        .header("User-Agent", "Branchline")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .bearer_auth(&token)
        .send()
        .map_err(|e| AppError::msg(format!("GitHub request failed: {e}")))?
        .error_for_status()
        .map_err(|e| AppError::msg(format!("GitHub auth failed. Check your PAT. {e}")))?
        .json()
        .map_err(|e| AppError::msg(format!("Could not parse GitHub user: {e}")))?;

    let created = client
        .post(format!("{base}/user/repos"))
        .header("Accept", "application/vnd.github+json")
        .header("User-Agent", "Branchline")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .bearer_auth(&token)
        .json(&serde_json::json!({
            "name": name,
            "description": input.description.trim(),
            "private": input.private,
            "auto_init": false,
        }))
        .send()
        .map_err(|e| AppError::msg(format!("GitHub create repo failed: {e}")))?;

    if !created.status().is_success() {
        let status = created.status();
        let body = created.text().unwrap_or_default();
        return Err(AppError::msg(format!(
            "Could not create GitHub repo ({status}). {body}"
        )));
    }

    let repo: GitHubRepo = created
        .json()
        .map_err(|e| AppError::msg(format!("Could not parse created repo: {e}")))?;

    let html_url = repo
        .html_url
        .clone()
        .unwrap_or_else(|| format!("https://github.com/{}", repo.full_name));
    let clone_url = repo.clone_url.clone();

    ensure_remote(&path, &remote_name, &clone_url)?;

    let branch = current_branch_or_head(&path)?;
    let auth_url = authenticated_https_url(&clone_url, &token)?;
    git_cli::run_git(
        &path,
        &["push", "-u", &auth_url, &format!("HEAD:refs/heads/{branch}")],
    )
    .map_err(|e| {
        AppError::msg(format!(
            "Repo created at {html_url}, but push failed: {e}. Add the remote and push manually."
        ))
    })?;

    let mut release_url = None;
    let mut tag_name = None;

    if input.create_release_tag {
        let tag = normalize_tag(&input.tag_name);
        if !tag.is_empty() {
            let _ = git_cli::run_git_allow_fail(&path, &["tag", &tag]);
            let push_tag = git_cli::run_git(&path, &["push", &auth_url, &format!("refs/tags/{tag}")]);
            if let Err(e) = push_tag {
                return Ok(PublishToGithubOutput {
                    ok: true,
                    message: format!(
                        "Published {}. Tag push failed: {e}",
                        repo.full_name
                    ),
                    full_name: repo.full_name,
                    html_url: html_url.clone(),
                    clone_url,
                    release_url: None,
                    tag_name: Some(tag),
                });
            }

            let release_resp = client
                .post(format!("{base}/repos/{}/releases", repo.full_name))
                .header("Accept", "application/vnd.github+json")
                .header("User-Agent", "Branchline")
                .header("X-GitHub-Api-Version", "2022-11-28")
                .bearer_auth(&token)
                .json(&serde_json::json!({
                    "tag_name": tag,
                    "name": format!("{} {tag}", name),
                    "body": "Download installers from Release assets once CI finishes building.",
                    "draft": false,
                    "generate_release_notes": true,
                }))
                .send();

            if let Ok(resp) = release_resp {
                if resp.status().is_success() {
                    if let Ok(rel) = resp.json::<GitHubRelease>() {
                        release_url = Some(rel.html_url);
                    }
                }
            }
            tag_name = Some(tag);
        }
    }

    let message = if let Some(ref url) = release_url {
        format!(
            "Published {} and opened release. Download link: {url}",
            repo.full_name
        )
    } else {
        format!("Published {} to GitHub", repo.full_name)
    };

    Ok(PublishToGithubOutput {
        ok: true,
        message,
        full_name: repo.full_name,
        html_url,
        clone_url,
        release_url,
        tag_name,
    })
}

fn github_connection(state: &State<'_, AppState>) -> AppResult<ConnectionConfig> {
    let settings = load_settings_with_tokens(state)?;
    settings
        .connections
        .into_iter()
        .find(|c| c.provider == "github" && c.enabled && !c.token.trim().is_empty())
        .ok_or_else(|| {
            AppError::msg(
                "GitHub is not linked. Open Settings → Connections, paste a PAT with repo scope, then try again.",
            )
        })
}

fn sanitize_repo_name(raw: &str) -> AppResult<String> {
    let name = raw.trim();
    if name.is_empty() {
        return Err(AppError::msg("Repository name is required"));
    }
    let cleaned: String = name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.' {
                c
            } else {
                '-'
            }
        })
        .collect();
    let cleaned = cleaned.trim_matches(|c| c == '-' || c == '.').to_string();
    if cleaned.is_empty() {
        return Err(AppError::msg("Repository name is invalid"));
    }
    Ok(cleaned)
}

fn normalize_tag(raw: &str) -> String {
    let t = raw.trim();
    if t.is_empty() {
        return String::new();
    }
    if t.starts_with('v') || t.starts_with('V') {
        t.to_string()
    } else {
        format!("v{t}")
    }
}

fn current_branch_or_head(path: &PathBuf) -> AppResult<String> {
    let (ok, out, _) = git_cli::run_git_allow_fail(path, &["rev-parse", "--abbrev-ref", "HEAD"]);
    if ok {
        let b = out.trim();
        if !b.is_empty() && b != "HEAD" {
            return Ok(b.to_string());
        }
    }
    Ok("main".into())
}

fn ensure_remote(path: &PathBuf, remote_name: &str, clone_url: &str) -> AppResult<()> {
    let (ok, out, _) = git_cli::run_git_allow_fail(path, &["remote"]);
    let exists = ok && out.lines().any(|l| l.trim() == remote_name);
    if exists {
        git_cli::run_git(path, &["remote", "set-url", remote_name, clone_url])?;
    } else {
        git_cli::run_git(path, &["remote", "add", remote_name, clone_url])?;
    }
    Ok(())
}

fn authenticated_https_url(clone_url: &str, token: &str) -> AppResult<String> {
    let url = clone_url.trim();
    if let Some(rest) = url.strip_prefix("https://") {
        return Ok(format!("https://x-access-token:{token}@{rest}"));
    }
    if let Some(rest) = url.strip_prefix("http://") {
        return Ok(format!("http://x-access-token:{token}@{rest}"));
    }
    Err(AppError::msg(
        "Expected an HTTPS clone URL from GitHub to push with your token.",
    ))
}

fn fetch_github_repos(connection: &ConnectionConfig) -> AppResult<Vec<HostRepository>> {
    let base = connection.base_url.trim().trim_end_matches('/');
    let client = reqwest::blocking::Client::new();
    let mut out = Vec::new();
    const PER_PAGE: u32 = 100;
    const MAX_PAGES: u32 = 10;

    for page in 1..=MAX_PAGES {
        let url = format!(
            "{base}/user/repos?per_page={PER_PAGE}&page={page}&sort=updated&affiliation=owner,collaborator,organization_member"
        );
        let response = client
            .get(&url)
            .header("Accept", "application/vnd.github+json")
            .header("User-Agent", "Branchline")
            .header("X-GitHub-Api-Version", "2022-11-28")
            .bearer_auth(connection.token.trim())
            .send()
            .map_err(|e| AppError::msg(format!("GitHub request failed: {e}")))?;

        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().unwrap_or_default();
            return Err(AppError::msg(format!(
                "GitHub returned {status}. Check your PAT scopes (repo). {body}"
            )));
        }

        let repos: Vec<GitHubRepo> = response
            .json()
            .map_err(|e| AppError::msg(format!("Could not parse GitHub response: {e}")))?;
        let count = repos.len();
        out.extend(repos.into_iter().map(|r| HostRepository {
            id: format!("github:{}", r.id),
            name: r.name,
            full_name: r.full_name,
            clone_url: r.clone_url,
            ssh_url: r.ssh_url,
            private: r.private,
            provider: "github".into(),
            updated_at: r.updated_at,
        }));
        if count < PER_PAGE as usize {
            break;
        }
    }

    Ok(out)
}

fn fetch_gitlab_repos(connection: &ConnectionConfig) -> AppResult<Vec<HostRepository>> {
    let base = connection.base_url.trim().trim_end_matches('/');
    let api = if base.ends_with("/api/v4") {
        base.to_string()
    } else {
        format!("{base}/api/v4")
    };
    let client = reqwest::blocking::Client::new();
    let mut out = Vec::new();
    const PER_PAGE: u32 = 100;
    const MAX_PAGES: u32 = 10;

    for page in 1..=MAX_PAGES {
        let url = format!(
            "{api}/projects?membership=true&simple=false&order_by=last_activity_at&per_page={PER_PAGE}&page={page}"
        );
        let response = client
            .get(&url)
            .header("User-Agent", "Branchline")
            .header("PRIVATE-TOKEN", connection.token.trim())
            .send()
            .map_err(|e| AppError::msg(format!("GitLab request failed: {e}")))?;

        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().unwrap_or_default();
            return Err(AppError::msg(format!(
                "GitLab returned {status}. Check your PAT. {body}"
            )));
        }

        let projects: Vec<GitLabProject> = response
            .json()
            .map_err(|e| AppError::msg(format!("Could not parse GitLab response: {e}")))?;
        let count = projects.len();
        out.extend(projects.into_iter().map(|p| HostRepository {
            id: format!("gitlab:{}", p.id),
            name: p.name,
            full_name: p.path_with_namespace,
            clone_url: p.http_url_to_repo,
            ssh_url: p.ssh_url_to_repo,
            private: p
                .visibility
                .as_deref()
                .map(|v| v != "public")
                .unwrap_or(true),
            provider: "gitlab".into(),
            updated_at: p.last_activity_at,
        }));
        if count < PER_PAGE as usize {
            break;
        }
    }

    Ok(out)
}
