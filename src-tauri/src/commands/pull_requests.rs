use crate::commands::settings::{load_settings_with_tokens, AppSettings, ConnectionConfig};
use crate::infrastructure::git_cli;
use crate::infrastructure::mock_providers::MockPullRequest;
use crate::state::AppState;
use crate::{run_blocking, AppError, AppResult};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use tauri::command;
use tauri::State;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListPullRequestsInput {
    pub path: String,
    #[serde(default)]
    pub connection_id: Option<String>,
    #[serde(default)]
    pub state: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatePullRequestInput {
    pub path: String,
    pub title: String,
    #[serde(default)]
    pub body: String,
    pub head: String,
    pub base: String,
    #[serde(default)]
    pub draft: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatePullRequestOutput {
    pub ok: bool,
    pub message: String,
    pub url: Option<String>,
    pub number: Option<u32>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListPrTemplatesInput {
    pub path: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoPrTemplate {
    pub id: String,
    pub name: String,
    pub relative_path: String,
    pub body: String,
}

#[derive(Debug, Deserialize)]
struct GhUser {
    login: String,
}

#[derive(Debug, Deserialize)]
struct GhLabel {
    name: String,
}

#[derive(Debug, Deserialize)]
struct GhRef {
    #[serde(default)]
    label: Option<String>,
    #[serde(default)]
    r#ref: Option<String>,
}

#[derive(Debug, Deserialize)]
struct GhPr {
    id: u64,
    number: u32,
    title: String,
    user: Option<GhUser>,
    html_url: String,
    state: String,
    draft: Option<bool>,
    updated_at: String,
    #[serde(default)]
    labels: Vec<GhLabel>,
    head: Option<GhRef>,
    base: Option<GhRef>,
    additions: Option<u32>,
    deletions: Option<u32>,
    comments: Option<u32>,
    review_comments: Option<u32>,
    requested_reviewers: Option<Vec<GhUser>>,
    assignees: Option<Vec<GhUser>>,
    merged_at: Option<String>,
}

fn linked_connection<'a>(
    settings: &'a AppSettings,
    provider: &str,
    connection_id: Option<&str>,
) -> Option<&'a ConnectionConfig> {
    settings.connections.iter().find(|c| {
        c.provider == provider
            && c.enabled
            && !c.token.trim().is_empty()
            && connection_id
                .map(|id| c.id == id || c.provider == id)
                .unwrap_or(true)
    })
}

fn github_connection_from(
    settings: &AppSettings,
    connection_id: Option<&str>,
) -> AppResult<ConnectionConfig> {
    if let Some(connection) = linked_connection(settings, "github", connection_id) {
        return Ok(connection.clone());
    }
    crate::commands::github_git::resolve_github_api_connection(settings).ok_or_else(|| {
        AppError::msg(
            "GitHub is not linked. Add a GitHub account under Settings → Connections, or sign in / paste a PAT.",
        )
    })
}

fn gitlab_connection_from(
    settings: &AppSettings,
    connection_id: Option<&str>,
) -> AppResult<ConnectionConfig> {
    linked_connection(settings, "gitlab", connection_id)
        .cloned()
        .ok_or_else(|| {
            AppError::msg(
                "GitLab is not linked. Open Settings → Connections and paste a personal access token.",
            )
        })
}

fn azure_connection_from(
    settings: &AppSettings,
    connection_id: Option<&str>,
) -> AppResult<ConnectionConfig> {
    linked_connection(settings, "azureDevOps", connection_id)
        .cloned()
        .ok_or_else(|| {
            AppError::msg(
                "Azure DevOps is not linked. Open Settings → Connections and paste a PAT.",
            )
        })
}

fn parse_github_owner_repo(url: &str) -> Option<(String, String)> {
    let u = url.trim();
    let rest = if let Some(r) = u.strip_prefix("git@github.com:") {
        r
    } else if let Some(r) = u.strip_prefix("ssh://git@github.com/") {
        r
    } else if let Some(r) = u.strip_prefix("https://github.com/") {
        r
    } else if let Some(r) = u.strip_prefix("http://github.com/") {
        r
    } else if let Some(idx) = u.find("github.com/") {
        &u[idx + "github.com/".len()..]
    } else if let Some(idx) = u.find("github.com:") {
        &u[idx + "github.com:".len()..]
    } else {
        return None;
    };
    let rest = rest.trim_end_matches('/').trim_end_matches(".git");
    let mut parts = rest.split('/');
    let owner = parts.next()?.trim();
    let repo = parts.next()?.trim();
    if owner.is_empty() || repo.is_empty() {
        return None;
    }
    Some((owner.to_string(), repo.to_string()))
}

fn resolve_github_repo(path: &PathBuf) -> AppResult<(String, String)> {
    let remotes = ["origin", "upstream"];
    for remote in remotes {
        let (ok, out, _) = git_cli::run_git_allow_fail(path, &["remote", "get-url", remote]);
        if ok {
            if let Some(pair) = parse_github_owner_repo(out.trim()) {
                return Ok(pair);
            }
        }
    }
    let (ok, out, _) = git_cli::run_git_allow_fail(path, &["remote", "-v"]);
    if ok {
        for line in out.lines() {
            let cols: Vec<&str> = line.split_whitespace().collect();
            if cols.len() >= 2 {
                if let Some(pair) = parse_github_owner_repo(cols[1]) {
                    return Ok(pair);
                }
            }
        }
    }
    Err(AppError::msg(
        "Could not detect a GitHub remote. Add an origin pointing at github.com.",
    ))
}

fn github_http_client() -> &'static reqwest::blocking::Client {
    static CLIENT: OnceLock<reqwest::blocking::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::blocking::Client::builder()
            .timeout(Duration::from_secs(20))
            .build()
            .unwrap_or_else(|_| reqwest::blocking::Client::new())
    })
}

fn github_login_cache() -> &'static Mutex<Option<(String, String)>> {
    static CACHE: OnceLock<Mutex<Option<(String, String)>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(None))
}

fn resolve_github_login(
    client: &reqwest::blocking::Client,
    base: &str,
    token: &str,
    username_hint: &str,
) -> String {
    let hint = username_hint.trim();
    if !hint.is_empty() {
        return hint.to_string();
    }
    if let Ok(guard) = github_login_cache().lock() {
        if let Some((cached_token, login)) = guard.as_ref() {
            if cached_token == token && !login.is_empty() {
                return login.clone();
            }
        }
    }
    let login = client
        .get(format!("{base}/user"))
        .header("Accept", "application/vnd.github+json")
        .header("User-Agent", "Branchline")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .bearer_auth(token)
        .send()
        .ok()
        .and_then(|r| r.json::<GhUser>().ok())
        .map(|u| u.login)
        .unwrap_or_default();
    if !login.is_empty() {
        if let Ok(mut guard) = github_login_cache().lock() {
            *guard = Some((token.to_string(), login.clone()));
        }
    }
    login
}

fn map_pr(pr: GhPr, repo: &str, me: &str) -> MockPullRequest {
    let draft = pr.draft.unwrap_or(false);
    let status = if pr.merged_at.is_some() {
        "merged".to_string()
    } else if pr.state == "closed" {
        "closed".to_string()
    } else {
        "open".to_string()
    };
    let author = pr
        .user
        .as_ref()
        .map(|u| u.login.clone())
        .unwrap_or_else(|| "unknown".into());
    let assignees = pr
        .assignees
        .unwrap_or_default()
        .into_iter()
        .map(|u| u.login)
        .collect::<Vec<_>>();
    let reviewers = pr
        .requested_reviewers
        .unwrap_or_default()
        .into_iter()
        .map(|u| u.login)
        .collect::<Vec<_>>();
    let source = pr
        .head
        .as_ref()
        .and_then(|h| h.r#ref.clone().or(h.label.clone()))
        .unwrap_or_default();
    let target = pr
        .base
        .as_ref()
        .and_then(|h| h.r#ref.clone().or(h.label.clone()))
        .unwrap_or_default();
    let comment_count = pr.comments.unwrap_or(0) + pr.review_comments.unwrap_or(0);
    let needs_my_review = !me.is_empty()
        && reviewers
            .iter()
            .any(|r| r.eq_ignore_ascii_case(me));
    MockPullRequest {
        id: format!("gh-{}", pr.id),
        number: pr.number,
        title: pr.title,
        author: author.clone(),
        assignees,
        reviewers: reviewers.clone(),
        team: String::new(),
        repo: repo.to_string(),
        source_branch: source,
        target_branch: target,
        status,
        url: pr.html_url,
        labels: pr.labels.into_iter().map(|l| l.name).collect(),
        updated_at: pr.updated_at,
        draft,
        review_state: "unknown".into(),
        pipeline_status: "unknown".into(),
        additions: pr.additions.unwrap_or(0),
        deletions: pr.deletions.unwrap_or(0),
        comment_count,
        is_mine: !me.is_empty() && author.eq_ignore_ascii_case(me),
        needs_my_review,
    }
}

#[command]
pub async fn list_pull_requests(
    state: State<'_, AppState>,
    input: ListPullRequestsInput,
) -> AppResult<Vec<MockPullRequest>> {
    let settings = load_settings_with_tokens(&state)?;
    run_blocking(move || list_pull_requests_inner(settings, input)).await
}

fn list_pull_requests_inner(
    settings: AppSettings,
    input: ListPullRequestsInput,
) -> AppResult<Vec<MockPullRequest>> {
    let path = PathBuf::from(&input.path);
    match resolve_pr_target(&path, &settings, input.connection_id.as_deref())? {
        PrTarget::Github(connection, owner, repo) => {
            list_github_prs(connection, owner, repo, &input)
        }
        PrTarget::Gitlab(connection, project) => list_gitlab_mrs(connection, project, &input),
        PrTarget::Azure(connection, org, project, repo) => {
            list_azure_prs(connection, org, project, repo, &input)
        }
    }
}

fn list_github_prs(
    connection: ConnectionConfig,
    owner: String,
    repo: String,
    input: &ListPullRequestsInput,
) -> AppResult<Vec<MockPullRequest>> {
    let full = format!("{owner}/{repo}");
    let base = connection.base_url.trim().trim_end_matches('/');
    let token = connection.token.trim();
    let client = github_http_client();
    let me = resolve_github_login(client, base, token, &connection.username);

    let state_q = match input.state.as_deref().map(str::trim).unwrap_or("open") {
        "all" => "all",
        "closed" => "closed",
        _ => "open",
    };

    let mut out = Vec::new();
    let url = format!(
        "{base}/repos/{full}/pulls?state={state_q}&per_page=100&page=1&sort=updated&direction=desc"
    );
    let response = client
        .get(&url)
        .header("Accept", "application/vnd.github+json")
        .header("User-Agent", "Branchline")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .bearer_auth(token)
        .send()
        .map_err(|e| AppError::msg(format!("GitHub PR request failed: {e}")))?;
    let status = response.status();
    if !status.is_success() {
        let body = response.text().unwrap_or_default();
        return Err(AppError::msg(format!(
            "Could not list pull requests ({status}). {body}"
        )));
    }
    let batch: Vec<GhPr> = response
        .json()
        .map_err(|e| AppError::msg(format!("Could not parse pull requests: {e}")))?;
    for pr in batch {
        out.push(map_pr(pr, &repo, &me));
    }

    Ok(out)
}

#[command]
pub fn list_pr_templates(input: ListPrTemplatesInput) -> AppResult<Vec<RepoPrTemplate>> {
    let path = PathBuf::from(&input.path);
    git_cli::with_repo_lock(&path, |repo| Ok(collect_pr_templates(repo)))
}

fn collect_pr_templates(repo: &Path) -> Vec<RepoPrTemplate> {
    let mut out = Vec::new();
    const SINGLES: &[&str] = &[
        "PULL_REQUEST_TEMPLATE.md",
        ".github/PULL_REQUEST_TEMPLATE.md",
        "docs/PULL_REQUEST_TEMPLATE.md",
        ".gitlab/merge_request_templates/Default.md",
    ];
    const DIRS: &[&str] = &[
        ".github/PULL_REQUEST_TEMPLATE",
        ".github/PULL_REQUEST_TEMPLATE.md",
        "docs/PULL_REQUEST_TEMPLATE",
        "PULL_REQUEST_TEMPLATE",
        ".gitlab/merge_request_templates",
    ];
    for rel in SINGLES {
        push_template_file(repo, repo.join(rel), &mut out);
    }
    for rel in DIRS {
        collect_template_dir(repo, &repo.join(rel), &mut out);
    }
    out
}

fn collect_template_dir(repo: &Path, dir: &Path, out: &mut Vec<RepoPrTemplate>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    let mut files: Vec<PathBuf> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            p.is_file()
                && p.extension()
                    .and_then(|e| e.to_str())
                    .is_some_and(|e| e.eq_ignore_ascii_case("md"))
        })
        .collect();
    files.sort();
    for file in files {
        push_template_file(repo, file, out);
    }
}

fn push_template_file(repo: &Path, path: PathBuf, out: &mut Vec<RepoPrTemplate>) {
    if !path.is_file() {
        return;
    }
    let rel = path
        .strip_prefix(repo)
        .unwrap_or(&path)
        .to_string_lossy()
        .replace('\\', "/");
    if out
        .iter()
        .any(|t| t.relative_path.eq_ignore_ascii_case(&rel))
    {
        return;
    }
    let Ok(body) = fs::read_to_string(&path) else {
        return;
    };
    if body.trim().is_empty() {
        return;
    }
    out.push(RepoPrTemplate {
        id: format!("repo:{rel}"),
        name: pretty_template_name(&path),
        relative_path: rel,
        body,
    });
}

fn pretty_template_name(path: &Path) -> String {
    let stem = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("Template");
    let key = stem.replace(['-', ' '], "_").to_ascii_lowercase();
    if key == "pull_request_template" || key == "merge_request_template" || key == "default" {
        "Repo default".into()
    } else {
        stem.replace(['_', '-'], " ")
    }
}

fn gh_command() -> Option<String> {
    for candidate in ["gh", "/opt/homebrew/bin/gh", "/usr/local/bin/gh"] {
        if Command::new(candidate)
            .arg("--version")
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
        {
            return Some(candidate.to_string());
        }
    }
    None
}

fn create_with_gh(path: &Path, input: &CreatePullRequestInput) -> AppResult<CreatePullRequestOutput> {
    let gh = gh_command().ok_or_else(|| {
        AppError::msg(
            "GitHub is not linked and GitHub CLI (gh) was not found. Link GitHub in Settings, install gh, or open the PR in the browser.",
        )
    })?;
    let mut cmd = Command::new(&gh);
    cmd.current_dir(path)
        .args([
            "pr",
            "create",
            "--title",
            input.title.trim(),
            "--body",
            &input.body,
            "--head",
            input.head.trim(),
            "--base",
            input.base.trim(),
        ]);
    if input.draft {
        cmd.arg("--draft");
    }
    let output = cmd
        .output()
        .map_err(|e| AppError::msg(format!("Could not run gh pr create: {e}")))?;
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if !output.status.success() {
        let detail = if stderr.is_empty() { stdout } else { stderr };
        return Ok(CreatePullRequestOutput {
            ok: false,
            message: if detail.is_empty() {
                "gh pr create failed".into()
            } else {
                detail
            },
            url: None,
            number: None,
        });
    }
    let url = stdout
        .lines()
        .rev()
        .find(|line| line.contains("://"))
        .map(|line| line.trim().to_string());
    Ok(CreatePullRequestOutput {
        ok: true,
        message: "Opened pull request with GitHub CLI".into(),
        url,
        number: None,
    })
}

#[command]
pub fn create_pull_request(
    state: State<'_, AppState>,
    input: CreatePullRequestInput,
) -> AppResult<CreatePullRequestOutput> {
    let path = PathBuf::from(&input.path);
    let title = input.title.trim();
    if title.is_empty() {
        return Ok(CreatePullRequestOutput {
            ok: false,
            message: "Title is required".into(),
            url: None,
            number: None,
        });
    }
    if input.head.trim().is_empty() || input.base.trim().is_empty() {
        return Ok(CreatePullRequestOutput {
            ok: false,
            message: "Head and base branches are required".into(),
            url: None,
            number: None,
        });
    }
    let settings = load_settings_with_tokens(&state)?;
    match resolve_pr_target(&path, &settings, None) {
        Ok(PrTarget::Github(connection, owner, repo)) => {
            create_github_pr(connection, owner, repo, &input)
        }
        Ok(PrTarget::Gitlab(connection, project)) => {
            create_gitlab_mr(connection, project, &input)
        }
        Ok(PrTarget::Azure(connection, org, project, repo)) => {
            create_azure_pr(connection, org, project, repo, &input)
        }
        Err(err) => {
            if resolve_github_repo(&path).is_ok() {
                create_with_gh(&path, &input)
            } else {
                Ok(CreatePullRequestOutput {
                    ok: false,
                    message: err.to_string(),
                    url: None,
                    number: None,
                })
            }
        }
    }
}

enum PrTarget {
    Github(ConnectionConfig, String, String),
    Gitlab(ConnectionConfig, String),
    Azure(ConnectionConfig, String, String, String),
}

struct ParsedRemote {
    host: String,
    parts: Vec<String>,
}

fn remote_urls(path: &PathBuf) -> Vec<String> {
    let mut urls = Vec::new();
    for remote in ["origin", "upstream"] {
        let (ok, out, _) = git_cli::run_git_allow_fail(path, &["remote", "get-url", remote]);
        if ok {
            let url = out.trim();
            if !url.is_empty() {
                urls.push(url.to_string());
            }
        }
    }
    let (ok, out, _) = git_cli::run_git_allow_fail(path, &["remote", "-v"]);
    if ok {
        for line in out.lines() {
            let cols: Vec<&str> = line.split_whitespace().collect();
            if cols.len() >= 2 {
                let url = cols[1].trim();
                if !url.is_empty() && !urls.iter().any(|u| u == url) {
                    urls.push(url.to_string());
                }
            }
        }
    }
    urls
}

fn parse_remote_url(url: &str) -> Option<ParsedRemote> {
    let u = url.trim();
    let (host, path) = if let Some(rest) = u.strip_prefix("git@") {
        let (host, path) = rest.split_once(':')?;
        (host.to_string(), path.to_string())
    } else if let Some(rest) = u.strip_prefix("ssh://") {
        let rest = rest.split_once('@').map(|(_, r)| r).unwrap_or(rest);
        let (hostport, path) = rest.split_once('/')?;
        let host = hostport.split(':').next()?.to_string();
        (host, path.to_string())
    } else {
        let rest = u
            .strip_prefix("https://")
            .or_else(|| u.strip_prefix("http://"))?;
        let rest = rest.split('@').next_back().unwrap_or(rest);
        let (host, path) = rest.split_once('/')?;
        (host.to_string(), path.to_string())
    };
    let host = host.trim().trim_end_matches('.').to_ascii_lowercase();
    let path = path.trim_end_matches('/').trim_end_matches(".git");
    let parts: Vec<String> = path
        .split('/')
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .collect();
    if host.is_empty() || parts.is_empty() {
        return None;
    }
    Some(ParsedRemote { host, parts })
}

fn host_from_base_url(raw: &str) -> Option<String> {
    let parsed = parse_remote_url(raw)?;
    Some(parsed.host)
}

fn encode_project_path(path: &str) -> String {
    path.split('/')
        .filter(|s| !s.is_empty())
        .map(|s| {
            let mut out = String::new();
            for b in s.bytes() {
                match b {
                    b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                        out.push(b as char);
                    }
                    _ => out.push_str(&format!("%{b:02X}")),
                }
            }
            out
        })
        .collect::<Vec<_>>()
        .join("%2F")
}

fn gitlab_api_base(raw: &str) -> String {
    let base = raw.trim().trim_end_matches('/');
    if base.ends_with("/api/v4") {
        base.to_string()
    } else {
        format!("{base}/api/v4")
    }
}

fn azure_from_remote(parsed: &ParsedRemote) -> Option<(String, String, String)> {
    if parsed.host == "ssh.dev.azure.com" {
        let mut parts = parsed.parts.iter();
        if parts.next().map(|s| s.as_str()) != Some("v3") {
            return None;
        }
        let org = parts.next()?.clone();
        let project = parts.next()?.clone();
        let repo = parts.next()?.clone();
        return Some((org, project, repo));
    }
    if parsed.host.ends_with(".visualstudio.com") {
        let org = parsed.host.split('.').next()?.to_string();
        let project = parsed.parts.first()?.clone();
        let repo = if parsed.parts.len() >= 3 && parsed.parts[1] == "_git" {
            parsed.parts[2].clone()
        } else {
            parsed.parts.last()?.clone()
        };
        return Some((org, project, repo));
    }
    if parsed.host == "dev.azure.com" {
        let org = parsed.parts.first()?.clone();
        let project = parsed.parts.get(1)?.clone();
        let repo = if parsed.parts.len() >= 4 && parsed.parts[2] == "_git" {
            parsed.parts[3].clone()
        } else {
            parsed.parts.last()?.clone()
        };
        return Some((org, project, repo));
    }
    None
}

fn resolve_pr_target(
    path: &PathBuf,
    settings: &AppSettings,
    connection_id: Option<&str>,
) -> AppResult<PrTarget> {
    let urls = remote_urls(path);
    let mut last_err = AppError::msg(
        "Could not detect a GitHub, GitLab, or Azure DevOps remote. Add origin, or link a matching host in Settings.",
    );
    for url in &urls {
        let Some(parsed) = parse_remote_url(url) else {
            continue;
        };
        if parsed.host == "github.com" || parsed.host.ends_with(".github.com") {
            if parsed.parts.len() < 2 {
                continue;
            }
            let owner = parsed.parts[0].clone();
            let repo = parsed.parts[1].clone();
            return Ok(PrTarget::Github(
                github_connection_from(settings, connection_id)?,
                owner,
                repo,
            ));
        }
        if parsed.host == "gitlab.com"
            || parsed.host.ends_with(".gitlab.com")
            || linked_connection(settings, "gitlab", connection_id)
                .and_then(|c| host_from_base_url(&c.base_url))
                .is_some_and(|h| h == parsed.host)
        {
            let project = parsed.parts.join("/");
            return Ok(PrTarget::Gitlab(
                gitlab_connection_from(settings, connection_id)?,
                project,
            ));
        }
        if let Some((org, project, repo)) = azure_from_remote(&parsed) {
            let mut connection = azure_connection_from(settings, connection_id)?;
            if connection.organization.trim().is_empty() {
                connection.organization = org.clone();
            }
            if connection.project.trim().is_empty() {
                connection.project = project.clone();
            }
            return Ok(PrTarget::Azure(connection, org, project, repo));
        }
        last_err = AppError::msg(format!("Unsupported git host: {}", parsed.host));
    }
    if let Ok((owner, repo)) = resolve_github_repo(path) {
        return Ok(PrTarget::Github(
            github_connection_from(settings, connection_id)?,
            owner,
            repo,
        ));
    }
    Err(last_err)
}

fn create_github_pr(
    connection: ConnectionConfig,
    owner: String,
    repo: String,
    input: &CreatePullRequestInput,
) -> AppResult<CreatePullRequestOutput> {
    let full = format!("{owner}/{repo}");
    let base = connection.base_url.trim().trim_end_matches('/');
    let token = connection.token.trim();
    let head = input.head.trim();
    let base_branch = input.base.trim();
    let client = github_http_client();
    let response = client
        .post(format!("{base}/repos/{full}/pulls"))
        .header("Accept", "application/vnd.github+json")
        .header("User-Agent", "Branchline")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .bearer_auth(token)
        .json(&serde_json::json!({
            "title": input.title.trim(),
            "body": input.body,
            "head": head,
            "base": base_branch,
            "draft": input.draft,
        }))
        .send()
        .map_err(|e| AppError::msg(format!("GitHub create PR failed: {e}")))?;

    let status = response.status();
    if !status.is_success() {
        let body = response.text().unwrap_or_default();
        return Ok(CreatePullRequestOutput {
            ok: false,
            message: format!("Could not create pull request ({status}). {body}"),
            url: None,
            number: None,
        });
    }

    #[derive(Deserialize)]
    struct Created {
        html_url: String,
        number: u32,
    }
    let created: Created = response
        .json()
        .map_err(|e| AppError::msg(format!("Could not parse created PR: {e}")))?;

    Ok(CreatePullRequestOutput {
        ok: true,
        message: format!("Opened PR #{}", created.number),
        url: Some(created.html_url),
        number: Some(created.number),
    })
}

#[derive(Debug, Deserialize)]
struct GlUser {
    #[serde(default)]
    username: String,
}

#[derive(Debug, Deserialize)]
struct GlMr {
    id: u64,
    iid: u32,
    title: String,
    #[serde(default)]
    author: Option<GlUser>,
    web_url: String,
    #[serde(default)]
    state: String,
    #[serde(default)]
    draft: Option<bool>,
    #[serde(default)]
    work_in_progress: Option<bool>,
    #[serde(default)]
    updated_at: String,
    #[serde(default)]
    labels: Vec<String>,
    #[serde(default)]
    source_branch: String,
    #[serde(default)]
    target_branch: String,
    #[serde(default)]
    user_notes_count: Option<u32>,
    #[serde(default)]
    assignees: Option<Vec<GlUser>>,
    #[serde(default)]
    reviewers: Option<Vec<GlUser>>,
    #[serde(default)]
    merged_at: Option<String>,
}

fn map_gitlab_mr(mr: GlMr, repo: &str, me: &str) -> MockPullRequest {
    let draft = mr.draft.or(mr.work_in_progress).unwrap_or(false);
    let status = if mr.merged_at.is_some() || mr.state == "merged" {
        "merged".to_string()
    } else if mr.state == "closed" {
        "closed".to_string()
    } else {
        "open".to_string()
    };
    let author = mr
        .author
        .as_ref()
        .map(|u| u.username.clone())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "unknown".into());
    let assignees = mr
        .assignees
        .unwrap_or_default()
        .into_iter()
        .map(|u| u.username)
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>();
    let reviewers = mr
        .reviewers
        .unwrap_or_default()
        .into_iter()
        .map(|u| u.username)
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>();
    let needs_my_review = !me.is_empty()
        && reviewers
            .iter()
            .any(|r| r.eq_ignore_ascii_case(me));
    MockPullRequest {
        id: format!("gl-{}", mr.id),
        number: mr.iid,
        title: mr.title,
        author: author.clone(),
        assignees,
        reviewers: reviewers.clone(),
        team: String::new(),
        repo: repo.to_string(),
        source_branch: mr.source_branch,
        target_branch: mr.target_branch,
        status,
        url: mr.web_url,
        labels: mr.labels,
        updated_at: mr.updated_at,
        draft,
        review_state: "unknown".into(),
        pipeline_status: "unknown".into(),
        additions: 0,
        deletions: 0,
        comment_count: mr.user_notes_count.unwrap_or(0),
        is_mine: !me.is_empty() && author.eq_ignore_ascii_case(me),
        needs_my_review,
    }
}

fn list_gitlab_mrs(
    connection: ConnectionConfig,
    project: String,
    input: &ListPullRequestsInput,
) -> AppResult<Vec<MockPullRequest>> {
    let api = gitlab_api_base(&connection.base_url);
    let token = connection.token.trim();
    let encoded = encode_project_path(&project);
    let repo = project.rsplit('/').next().unwrap_or(&project).to_string();
    let me = connection.username.trim().to_string();
    let states: Vec<&str> = match input.state.as_deref().map(str::trim).unwrap_or("open") {
        "all" => vec!["all"],
        "closed" => vec!["closed", "merged"],
        _ => vec!["opened"],
    };
    let client = github_http_client();
    let mut out = Vec::new();
    for state in states {
        let url = format!(
            "{api}/projects/{encoded}/merge_requests?state={state}&per_page=100&order_by=updated_at&sort=desc"
        );
        let response = client
            .get(&url)
            .header("User-Agent", "Branchline")
            .header("PRIVATE-TOKEN", token)
            .send()
            .map_err(|e| AppError::msg(format!("GitLab MR request failed: {e}")))?;
        let status = response.status();
        if !status.is_success() {
            let body = response.text().unwrap_or_default();
            return Err(AppError::msg(format!(
                "Could not list merge requests ({status}). {body}"
            )));
        }
        let batch: Vec<GlMr> = response
            .json()
            .map_err(|e| AppError::msg(format!("Could not parse merge requests: {e}")))?;
        for mr in batch {
            out.push(map_gitlab_mr(mr, &repo, &me));
        }
    }
    Ok(out)
}

fn create_gitlab_mr(
    connection: ConnectionConfig,
    project: String,
    input: &CreatePullRequestInput,
) -> AppResult<CreatePullRequestOutput> {
    let api = gitlab_api_base(&connection.base_url);
    let token = connection.token.trim();
    let encoded = encode_project_path(&project);
    let client = github_http_client();
    let response = client
        .post(format!("{api}/projects/{encoded}/merge_requests"))
        .header("User-Agent", "Branchline")
        .header("PRIVATE-TOKEN", token)
        .json(&serde_json::json!({
            "source_branch": input.head.trim(),
            "target_branch": input.base.trim(),
            "title": input.title.trim(),
            "description": input.body,
            "draft": input.draft,
        }))
        .send()
        .map_err(|e| AppError::msg(format!("GitLab create MR failed: {e}")))?;
    let status = response.status();
    if !status.is_success() {
        let body = response.text().unwrap_or_default();
        return Ok(CreatePullRequestOutput {
            ok: false,
            message: format!("Could not create merge request ({status}). {body}"),
            url: None,
            number: None,
        });
    }
    let created: GlMr = response
        .json()
        .map_err(|e| AppError::msg(format!("Could not parse created merge request: {e}")))?;
    Ok(CreatePullRequestOutput {
        ok: true,
        message: format!("Opened merge request !{}", created.iid),
        url: Some(created.web_url),
        number: Some(created.iid),
    })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AzIdentity {
    #[serde(default)]
    display_name: Option<String>,
    #[serde(default)]
    unique_name: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AzReviewer {
    #[serde(default)]
    display_name: Option<String>,
    #[serde(default)]
    unique_name: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AzPr {
    pull_request_id: u32,
    title: String,
    #[serde(default)]
    status: String,
    #[serde(default)]
    created_by: Option<AzIdentity>,
    #[serde(default)]
    creation_date: Option<String>,
    #[serde(default)]
    closed_date: Option<String>,
    #[serde(default)]
    source_ref_name: String,
    #[serde(default)]
    target_ref_name: String,
    #[serde(default)]
    is_draft: Option<bool>,
    #[serde(default)]
    reviewers: Option<Vec<AzReviewer>>,
    #[serde(default)]
    url: Option<String>,
}

fn strip_refs(name: &str) -> String {
    name.trim()
        .trim_start_matches("refs/heads/")
        .trim_start_matches("refs/tags/")
        .to_string()
}

fn az_name(id: &Option<AzIdentity>) -> String {
    id.as_ref()
        .and_then(|u| {
            u.display_name
                .as_deref()
                .filter(|s| !s.is_empty())
                .or(u.unique_name.as_deref())
        })
        .unwrap_or("unknown")
        .to_string()
}

fn map_azure_pr(pr: AzPr, repo: &str, org: &str, project: &str, me: &str) -> MockPullRequest {
    let status = match pr.status.to_ascii_lowercase().as_str() {
        "completed" => "merged".to_string(),
        "abandoned" => "closed".to_string(),
        _ => "open".to_string(),
    };
    let author = az_name(&pr.created_by);
    let reviewers = pr
        .reviewers
        .unwrap_or_default()
        .into_iter()
        .filter_map(|r| {
            r.display_name
                .filter(|s| !s.is_empty())
                .or(r.unique_name)
        })
        .collect::<Vec<_>>();
    let needs_my_review = !me.is_empty()
        && reviewers
            .iter()
            .any(|r| r.eq_ignore_ascii_case(me));
    let url = pr.url.clone().unwrap_or_else(|| {
        format!(
            "https://dev.azure.com/{org}/{project}/_git/{repo}/pullrequest/{}",
            pr.pull_request_id
        )
    });
    let web = if url.contains("/_apis/") {
        format!(
            "https://dev.azure.com/{org}/{project}/_git/{repo}/pullrequest/{}",
            pr.pull_request_id
        )
    } else {
        url
    };
    MockPullRequest {
        id: format!("az-{}", pr.pull_request_id),
        number: pr.pull_request_id,
        title: pr.title,
        author: author.clone(),
        assignees: Vec::new(),
        reviewers: reviewers.clone(),
        team: String::new(),
        repo: repo.to_string(),
        source_branch: strip_refs(&pr.source_ref_name),
        target_branch: strip_refs(&pr.target_ref_name),
        status,
        url: web,
        labels: Vec::new(),
        updated_at: pr.closed_date.or(pr.creation_date).unwrap_or_default(),
        draft: pr.is_draft.unwrap_or(false),
        review_state: "unknown".into(),
        pipeline_status: "unknown".into(),
        additions: 0,
        deletions: 0,
        comment_count: 0,
        is_mine: !me.is_empty() && author.eq_ignore_ascii_case(me),
        needs_my_review,
    }
}

fn azure_api_base(connection: &ConnectionConfig) -> String {
    connection.base_url.trim().trim_end_matches('/').to_string()
}

fn list_azure_prs(
    connection: ConnectionConfig,
    org: String,
    project: String,
    repo: String,
    input: &ListPullRequestsInput,
) -> AppResult<Vec<MockPullRequest>> {
    let org = if connection.organization.trim().is_empty() {
        org
    } else {
        connection.organization.trim().to_string()
    };
    let project = if connection.project.trim().is_empty() {
        project
    } else {
        connection.project.trim().to_string()
    };
    let base = azure_api_base(&connection);
    let token = connection.token.trim();
    let statuses: Vec<&str> = match input.state.as_deref().map(str::trim).unwrap_or("open") {
        "all" => vec!["all"],
        "closed" => vec!["completed", "abandoned"],
        _ => vec!["active"],
    };
    let client = github_http_client();
    let me = connection.username.trim().to_string();
    let mut out = Vec::new();
    for status in statuses {
        let url = format!(
            "{base}/{org}/{project}/_apis/git/repositories/{repo}/pullrequests?searchCriteria.status={status}&api-version=7.1"
        );
        let response = client
            .get(&url)
            .header("User-Agent", "Branchline")
            .header("Accept", "application/json")
            .basic_auth("", Some(token))
            .send()
            .map_err(|e| AppError::msg(format!("Azure DevOps PR request failed: {e}")))?;
        let http_status = response.status();
        if !http_status.is_success() {
            let body = response.text().unwrap_or_default();
            return Err(AppError::msg(format!(
                "Could not list pull requests ({http_status}). {body}"
            )));
        }
        let body: serde_json::Value = response
            .json()
            .map_err(|e| AppError::msg(format!("Could not parse Azure pull requests: {e}")))?;
        let batch = body
            .get("value")
            .cloned()
            .unwrap_or(serde_json::Value::Array(vec![]));
        let prs: Vec<AzPr> = serde_json::from_value(batch)
            .map_err(|e| AppError::msg(format!("Could not parse Azure pull requests: {e}")))?;
        for pr in prs {
            out.push(map_azure_pr(pr, &repo, &org, &project, &me));
        }
    }
    Ok(out)
}

fn create_azure_pr(
    connection: ConnectionConfig,
    org: String,
    project: String,
    repo: String,
    input: &CreatePullRequestInput,
) -> AppResult<CreatePullRequestOutput> {
    let org = if connection.organization.trim().is_empty() {
        org
    } else {
        connection.organization.trim().to_string()
    };
    let project = if connection.project.trim().is_empty() {
        project
    } else {
        connection.project.trim().to_string()
    };
    let base = azure_api_base(&connection);
    let token = connection.token.trim();
    let client = github_http_client();
    let url = format!(
        "{base}/{org}/{project}/_apis/git/repositories/{repo}/pullrequests?api-version=7.1"
    );
    let response = client
        .post(&url)
        .header("User-Agent", "Branchline")
        .header("Accept", "application/json")
        .basic_auth("", Some(token))
        .json(&serde_json::json!({
            "sourceRefName": format!("refs/heads/{}", input.head.trim()),
            "targetRefName": format!("refs/heads/{}", input.base.trim()),
            "title": input.title.trim(),
            "description": input.body,
            "isDraft": input.draft,
        }))
        .send()
        .map_err(|e| AppError::msg(format!("Azure DevOps create PR failed: {e}")))?;
    let status = response.status();
    if !status.is_success() {
        let body = response.text().unwrap_or_default();
        return Ok(CreatePullRequestOutput {
            ok: false,
            message: format!("Could not create pull request ({status}). {body}"),
            url: None,
            number: None,
        });
    }
    let created: AzPr = response
        .json()
        .map_err(|e| AppError::msg(format!("Could not parse created pull request: {e}")))?;
    let web = format!(
        "https://dev.azure.com/{org}/{project}/_git/{repo}/pullrequest/{}",
        created.pull_request_id
    );
    Ok(CreatePullRequestOutput {
        ok: true,
        message: format!("Opened PR #{}", created.pull_request_id),
        url: Some(web),
        number: Some(created.pull_request_id),
    })
}
