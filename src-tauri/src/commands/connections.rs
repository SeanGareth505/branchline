use crate::commands::remotes::{resolve_probe_url, run_ls_remote};
use crate::commands::settings::{load_settings_with_tokens, AppSettings, ConnectionConfig};
use crate::state::AppState;
use crate::{run_blocking, AppResult};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use tauri::command;
use tauri::State;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TestConnectionInput {
    pub kind: String,
    #[serde(default)]
    pub connection_id: String,
    #[serde(default)]
    pub path: String,
    #[serde(default)]
    pub remote: String,
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub host: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TestConnectionOutput {
    pub ok: bool,
    pub kind: String,
    #[serde(default)]
    pub connection_id: String,
    pub account: String,
    pub message: String,
    pub detail: String,
}

#[derive(Debug, Deserialize)]
struct GitHubUser {
    login: String,
    #[serde(default)]
    name: Option<String>,
}

#[derive(Debug, Deserialize)]
struct GitLabUser {
    #[serde(default)]
    username: String,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    email: Option<String>,
}

#[derive(Debug, Deserialize)]
struct JiraMyself {
    #[serde(default, rename = "displayName")]
    display_name: Option<String>,
    #[serde(default, rename = "emailAddress")]
    email_address: Option<String>,
}

#[command]
pub async fn test_connection(
    state: State<'_, AppState>,
    input: TestConnectionInput,
) -> AppResult<TestConnectionOutput> {
    let settings = load_settings_with_tokens(&state)?;
    run_blocking(move || Ok(test_connection_inner(settings, input))).await
}

fn test_connection_inner(settings: AppSettings, input: TestConnectionInput) -> TestConnectionOutput {
    let kind = input.kind.trim();
    let mut result = match kind {
        "github" | "gitlab" | "azureDevOps" | "jira" => test_integration(&settings, kind, &input),
        "gitRemote" => test_git_remote(&input),
        "ssh" => test_ssh(&input),
        _ => fail(kind, "Unknown connection type"),
    };
    if result.connection_id.is_empty() {
        result.connection_id = input.connection_id.clone();
    }
    result
}

fn test_integration(
    settings: &AppSettings,
    kind: &str,
    input: &TestConnectionInput,
) -> TestConnectionOutput {
    let Some(connection) = find_connection(settings, &input.connection_id, kind) else {
        return fail(kind, "This integration is not configured.");
    };
    if connection.token.trim().is_empty() {
        return fail(kind, "Paste a token first, then test again.");
    }
    match kind {
        "github" => test_github(connection),
        "gitlab" => test_gitlab(connection),
        "azureDevOps" => test_azure(connection),
        "jira" => test_jira(connection),
        _ => fail(kind, "Unknown connection type"),
    }
}

fn test_github(connection: &ConnectionConfig) -> TestConnectionOutput {
    let base = github_api_base(&connection.base_url);
    let response = match client()
        .get(format!("{base}/user"))
        .header("Accept", "application/vnd.github+json")
        .header("User-Agent", "Branchline")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .bearer_auth(connection.token.trim())
        .send()
    {
        Ok(response) => response,
        Err(err) => return fail("github", format!("GitHub request failed: {err}")),
    };
    if !response.status().is_success() {
        return fail(
            "github",
            format!(
                "GitHub returned {}. Check the PAT and repo scope. {}",
                response.status(),
                clip(&response.text().unwrap_or_default())
            ),
        );
    }
    match response.json::<GitHubUser>() {
        Ok(user) => ok(
            "github",
            &user.login,
            format!(
                "Signed in to GitHub as {}",
                user.name
                    .filter(|n| !n.trim().is_empty())
                    .unwrap_or_else(|| user.login.clone())
            ),
        ),
        Err(err) => fail("github", format!("Could not parse GitHub user: {err}")),
    }
}

fn test_gitlab(connection: &ConnectionConfig) -> TestConnectionOutput {
    let api = gitlab_api_base(&connection.base_url);
    let response = match client()
        .get(format!("{api}/user"))
        .header("User-Agent", "Branchline")
        .header("PRIVATE-TOKEN", connection.token.trim())
        .send()
    {
        Ok(response) => response,
        Err(err) => return fail("gitlab", format!("GitLab request failed: {err}")),
    };
    if !response.status().is_success() {
        return fail(
            "gitlab",
            format!(
                "GitLab returned {}. Check the PAT. {}",
                response.status(),
                clip(&response.text().unwrap_or_default())
            ),
        );
    }
    match response.json::<GitLabUser>() {
        Ok(user) => {
            let account = if !user.username.trim().is_empty() {
                user.username
            } else {
                user.email.unwrap_or_default()
            };
            let label = user
                .name
                .filter(|n| !n.trim().is_empty())
                .unwrap_or_else(|| account.clone());
            ok("gitlab", &account, format!("Signed in to GitLab as {label}"))
        }
        Err(err) => fail("gitlab", format!("Could not parse GitLab user: {err}")),
    }
}

fn test_azure(connection: &ConnectionConfig) -> TestConnectionOutput {
    let org = connection.organization.trim();
    if org.is_empty() {
        return fail("azureDevOps", "Set the Azure DevOps organization, then test again.");
    }
    let base = connection.base_url.trim().trim_end_matches('/');
    let url = format!("{base}/{org}/_apis/connectionData?api-version=7.1");
    let response = match client()
        .get(&url)
        .header("User-Agent", "Branchline")
        .header("Accept", "application/json")
        .basic_auth("", Some(connection.token.trim()))
        .send()
    {
        Ok(response) => response,
        Err(err) => return fail("azureDevOps", format!("Azure DevOps request failed: {err}")),
    };
    if !response.status().is_success() {
        return fail(
            "azureDevOps",
            format!(
                "Azure DevOps returned {}. Check the PAT, organization, and Code scope. {}",
                response.status(),
                clip(&response.text().unwrap_or_default())
            ),
        );
    }
    let body = response.json::<serde_json::Value>().unwrap_or(serde_json::Value::Null);
    let account = body
        .pointer("/authenticatedUser/providerDisplayName")
        .or_else(|| body.pointer("/authenticatedUser/displayName"))
        .and_then(|v| v.as_str())
        .unwrap_or(org)
        .to_string();
    ok(
        "azureDevOps",
        &account,
        format!("Reached Azure DevOps organization {org} as {account}"),
    )
}

fn test_jira(connection: &ConnectionConfig) -> TestConnectionOutput {
    if connection.username.trim().is_empty() {
        return fail("jira", "Set the Atlassian account email, then test again.");
    }
    if connection.base_url.trim().is_empty() || connection.base_url.contains("your-domain") {
        return fail("jira", "Set the Jira site URL, then test again.");
    }
    let url = format!("{}/myself", jira_api_base(connection));
    let response = match client()
        .get(&url)
        .basic_auth(connection.username.trim(), Some(connection.token.trim()))
        .header("Accept", "application/json")
        .header("User-Agent", "Branchline")
        .send()
    {
        Ok(response) => response,
        Err(err) => return fail("jira", format!("Jira request failed: {err}")),
    };
    if !response.status().is_success() {
        return fail(
            "jira",
            format!(
                "Jira returned {}. Check the site URL, email, and API token. {}",
                response.status(),
                clip(&response.text().unwrap_or_default())
            ),
        );
    }
    match response.json::<JiraMyself>() {
        Ok(me) => {
            let account = me
                .email_address
                .filter(|v| !v.trim().is_empty())
                .or(me.display_name.clone())
                .unwrap_or_else(|| connection.username.clone());
            ok(
                "jira",
                &account,
                format!(
                    "Signed in to Jira as {}",
                    me.display_name.unwrap_or_else(|| account.clone())
                ),
            )
        }
        Err(err) => fail("jira", format!("Could not parse Jira profile: {err}")),
    }
}

fn test_git_remote(input: &TestConnectionInput) -> TestConnectionOutput {
    let path = PathBuf::from(input.path.trim());
    let cwd = if path.as_os_str().is_empty() {
        std::env::temp_dir()
    } else {
        path
    };
    let url = match resolve_probe_url(
        &cwd,
        Some(input.url.as_str()).filter(|v| !v.trim().is_empty()),
        Some(input.remote.as_str()).filter(|v| !v.trim().is_empty()),
    ) {
        Ok(url) if !url.trim().is_empty() => url,
        Ok(_) => return fail("gitRemote", "No remote URL to test. Open a repo or pass a URL."),
        Err(err) => return fail("gitRemote", err.to_string()),
    };
    let probe = run_ls_remote(&cwd, &url);
    TestConnectionOutput {
        ok: probe.ok,
        kind: "gitRemote".into(),
        connection_id: input.remote.trim().to_string(),
        account: input.remote.trim().to_string(),
        message: if probe.ok {
            format!("Reached {} ({})", url, probe.protocol)
        } else {
            format!("Could not reach {}", url)
        },
        detail: probe.message,
    }
}

fn test_ssh(input: &TestConnectionInput) -> TestConnectionOutput {
    let host = ssh_host(input);
    let child = match Command::new("ssh")
        .args([
            "-o",
            "BatchMode=yes",
            "-o",
            "ConnectTimeout=10",
            "-o",
            "StrictHostKeyChecking=accept-new",
            "-T",
            &format!("git@{host}"),
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
    {
        Ok(child) => child,
        Err(err) => {
            return fail(
                "ssh",
                format!("Could not run ssh ({err}). Install OpenSSH or switch the SSH client."),
            )
        }
    };
    let output = match child.wait_with_output() {
        Ok(output) => output,
        Err(err) => return fail("ssh", format!("SSH test failed: {err}")),
    };
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let combined = format!("{stdout}\n{stderr}");
    let text = combined.trim();
    if looks_like_ssh_success(text) {
        let account = ssh_account(text).unwrap_or_default();
        return ok(
            "ssh",
            &account,
            if account.is_empty() {
                format!("SSH authenticated to {host}")
            } else {
                format!("SSH authenticated to {host} as {account}")
            },
        );
    }
    fail(
        "ssh",
        if text.is_empty() {
            format!("SSH could not reach git@{host}")
        } else {
            clip(text)
        },
    )
}

fn find_connection<'a>(
    settings: &'a AppSettings,
    id: &str,
    kind: &str,
) -> Option<&'a ConnectionConfig> {
    let id = id.trim();
    settings.connections.iter().find(|connection| {
        if !id.is_empty() {
            connection.id == id || connection.provider == id
        } else {
            connection.provider == kind
        }
    })
}

fn github_api_base(raw: &str) -> String {
    let base = raw.trim().trim_end_matches('/');
    if base.is_empty() || base == "https://github.com" || base == "http://github.com" {
        "https://api.github.com".into()
    } else {
        base.to_string()
    }
}

fn gitlab_api_base(raw: &str) -> String {
    let base = raw.trim().trim_end_matches('/');
    if base.ends_with("/api/v4") {
        base.to_string()
    } else {
        format!("{base}/api/v4")
    }
}

fn jira_api_base(connection: &ConnectionConfig) -> String {
    let base = connection.base_url.trim().trim_end_matches('/');
    if base.ends_with("/rest/api/3") {
        base.to_string()
    } else if base.ends_with("/rest/api/2") {
        format!("{}/rest/api/3", base.trim_end_matches("/rest/api/2"))
    } else {
        format!("{base}/rest/api/3")
    }
}

fn ssh_host(input: &TestConnectionInput) -> String {
    let explicit = input.host.trim();
    if !explicit.is_empty() {
        return explicit.to_string();
    }
    let url = input.url.trim();
    if let Some(host) = host_from_remote(url) {
        return host;
    }
    if !input.path.trim().is_empty() {
        if let Ok(url) = resolve_probe_url(
            Path::new(input.path.trim()),
            None,
            Some(input.remote.as_str()).filter(|v| !v.trim().is_empty()),
        ) {
            if let Some(host) = host_from_remote(&url) {
                return host;
            }
        }
    }
    "github.com".into()
}

fn host_from_remote(url: &str) -> Option<String> {
    let raw = url.trim();
    if let Some(rest) = raw.strip_prefix("git@") {
        return rest.split(':').next().filter(|h| !h.is_empty()).map(str::to_string);
    }
    if let Some(rest) = raw.strip_prefix("ssh://") {
        let rest = rest.strip_prefix("git@").unwrap_or(rest);
        let host = rest
            .split('/')
            .next()?
            .rsplit('@')
            .next()?
            .split(':')
            .next()?;
        return (!host.is_empty()).then(|| host.to_string());
    }
    let without = raw
        .trim_start_matches("https://")
        .trim_start_matches("http://");
    let host = without
        .split('/')
        .next()?
        .rsplit('@')
        .next()?
        .split(':')
        .next()?;
    (!host.is_empty()).then(|| host.to_string())
}

fn looks_like_ssh_success(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    lower.contains("successfully authenticated")
        || lower.contains("welcome to gitlab")
        || (lower.contains("you've successfully authenticated") && !lower.contains("permission denied"))
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

fn client() -> reqwest::blocking::Client {
    reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .unwrap_or_else(|_| reqwest::blocking::Client::new())
}

fn ok(kind: &str, account: &str, message: impl Into<String>) -> TestConnectionOutput {
    let message = message.into();
    TestConnectionOutput {
        ok: true,
        kind: kind.into(),
        connection_id: String::new(),
        account: account.to_string(),
        message: message.clone(),
        detail: message,
    }
}

fn fail(kind: &str, message: impl Into<String>) -> TestConnectionOutput {
    let message = message.into();
    TestConnectionOutput {
        ok: false,
        kind: kind.into(),
        connection_id: String::new(),
        account: String::new(),
        message: message.clone(),
        detail: message,
    }
}

fn clip(text: &str) -> String {
    let compact: String = text.split_whitespace().collect::<Vec<_>>().join(" ");
    const MAX: usize = 240;
    if compact.chars().count() <= MAX {
        compact
    } else {
        let clipped: String = compact.chars().take(MAX).collect();
        format!("{clipped}…")
    }
}
