use crate::commands::settings::{load_settings_with_tokens, ConnectionConfig};
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

fn github_connection(state: &State<'_, AppState>, connection_id: Option<&str>) -> AppResult<ConnectionConfig> {
    let settings = load_settings_with_tokens(state)?;
    settings
        .connections
        .into_iter()
        .find(|c| {
            c.provider == "github"
                && c.enabled
                && !c.token.trim().is_empty()
                && connection_id
                    .map(|id| c.id == id || c.provider == id)
                    .unwrap_or(true)
        })
        .ok_or_else(|| {
            AppError::msg(
                "GitHub is not linked. Open Settings → Connections and sign in or paste a PAT.",
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
    let connection = github_connection(&state, input.connection_id.as_deref())?;
    run_blocking(move || list_pull_requests_inner(connection, input)).await
}

fn list_pull_requests_inner(
    connection: ConnectionConfig,
    input: ListPullRequestsInput,
) -> AppResult<Vec<MockPullRequest>> {
    let path = PathBuf::from(&input.path);
    let (owner, repo) = resolve_github_repo(&path)?;
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
    let connection = match github_connection(&state, None) {
        Ok(connection) => connection,
        Err(_) => return create_with_gh(&path, &input),
    };
    let (owner, repo) = resolve_github_repo(&path)?;
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
            "title": title,
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
