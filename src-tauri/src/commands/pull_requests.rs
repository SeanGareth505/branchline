use crate::commands::settings::{load_settings_with_tokens, ConnectionConfig};
use crate::infrastructure::git_cli;
use crate::infrastructure::mock_providers::MockPullRequest;
use crate::state::AppState;
use crate::{AppError, AppResult};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
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
        // List endpoint does not include review decision / CI — UI hides those filters for live data.
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
pub fn list_pull_requests(
    state: State<'_, AppState>,
    input: ListPullRequestsInput,
) -> AppResult<Vec<MockPullRequest>> {
    let connection = github_connection(&state, input.connection_id.as_deref())?;
    let path = PathBuf::from(&input.path);
    let (owner, repo) = resolve_github_repo(&path)?;
    let full = format!("{owner}/{repo}");
    let base = connection.base_url.trim().trim_end_matches('/');
    let token = connection.token.trim();
    let client = reqwest::blocking::Client::new();

    let me = client
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

    let state_q = match input.state.as_deref().map(str::trim).unwrap_or("open") {
        "all" => "all",
        "closed" => "closed",
        _ => "open",
    };

    let mut out = Vec::new();
    const PER_PAGE: u32 = 50;
    const MAX_PAGES: u32 = 4;

    for page in 1..=MAX_PAGES {
        let url = format!(
            "{base}/repos/{full}/pulls?state={state_q}&per_page={PER_PAGE}&page={page}&sort=updated&direction=desc"
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
        let n = batch.len();
        for pr in batch {
            out.push(map_pr(pr, &repo, &me));
        }
        if n < PER_PAGE as usize {
            break;
        }
    }

    Ok(out)
}

#[command]
pub fn create_pull_request(
    state: State<'_, AppState>,
    input: CreatePullRequestInput,
) -> AppResult<CreatePullRequestOutput> {
    let connection = github_connection(&state, None)?;
    let path = PathBuf::from(&input.path);
    let (owner, repo) = resolve_github_repo(&path)?;
    let full = format!("{owner}/{repo}");
    let base = connection.base_url.trim().trim_end_matches('/');
    let token = connection.token.trim();
    let title = input.title.trim();
    if title.is_empty() {
        return Ok(CreatePullRequestOutput {
            ok: false,
            message: "Title is required".into(),
            url: None,
            number: None,
        });
    }
    let head = input.head.trim();
    let base_branch = input.base.trim();
    if head.is_empty() || base_branch.is_empty() {
        return Ok(CreatePullRequestOutput {
            ok: false,
            message: "Head and base branches are required".into(),
            url: None,
            number: None,
        });
    }

    let client = reqwest::blocking::Client::new();
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
