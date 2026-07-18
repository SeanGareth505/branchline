use crate::commands::settings::{load_settings_with_tokens, ConnectionConfig};
use crate::state::AppState;
use crate::{AppError, AppResult};
use serde::{Deserialize, Serialize};
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
struct GitHubRepo {
    id: u64,
    name: String,
    full_name: String,
    clone_url: String,
    ssh_url: String,
    private: bool,
    updated_at: Option<String>,
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
