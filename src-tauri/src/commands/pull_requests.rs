use crate::commands::settings::{load_settings_with_tokens, AppSettings, ConnectionConfig};
use crate::infrastructure::git_cli;
use crate::infrastructure::mock_providers::MockPullRequest;
use crate::state::AppState;
use crate::{run_blocking, AppError, AppResult};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
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
    #[serde(default)]
    sha: Option<String>,
}

#[derive(Debug, Deserialize)]
struct GhPr {
    id: u64,
    number: u32,
    title: String,
    #[serde(default)]
    body: Option<String>,
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
    #[serde(default)]
    mergeable: Option<bool>,
    #[serde(default)]
    mergeable_state: Option<String>,
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
            .timeout(Duration::from_secs(45))
            .build()
            .unwrap_or_else(|_| reqwest::blocking::Client::new())
    })
}

fn github_graphql_client() -> &'static reqwest::blocking::Client {
    static CLIENT: OnceLock<reqwest::blocking::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::blocking::Client::builder()
            .timeout(Duration::from_secs(8))
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
    let pending_reviewers = reviewers.len() as u32;
    let mut mapped = MockPullRequest {
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
        body: pr.body.unwrap_or_default(),
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
        pending_reviewers,
        mergeable: pr.mergeable,
        merge_state: pr
            .mergeable_state
            .unwrap_or_default()
            .to_ascii_lowercase(),
        ..Default::default()
    };
    finalize_pr_insights(&mut mapped);
    mapped
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
    let base = connection.base_url.trim().trim_end_matches('/');
    let token = connection.token.trim();
    let client = github_http_client();
    let me = resolve_github_login(client, base, token, &connection.username);

    match list_github_prs_graphql(
        github_graphql_client(),
        base,
        token,
        &owner,
        &repo,
        &me,
        input,
    ) {
        Ok(prs) => Ok(prs),
        Err(_) => list_github_prs_rest(client, base, token, &owner, &repo, &me, input),
    }
}

fn github_graphql_url(api_base: &str) -> String {
    let base = api_base.trim().trim_end_matches('/');
    if base.contains("api.github.com") {
        return "https://api.github.com/graphql".into();
    }
    if let Some(stripped) = base.strip_suffix("/api/v3") {
        return format!("{stripped}/api/graphql");
    }
    format!("{base}/graphql")
}

fn github_pr_states(input: &ListPullRequestsInput) -> Vec<&'static str> {
    match input.state.as_deref().map(str::trim).unwrap_or("open") {
        "all" => vec!["OPEN", "CLOSED", "MERGED"],
        "closed" => vec!["CLOSED", "MERGED"],
        _ => vec!["OPEN"],
    }
}

const GITHUB_PR_QUERY: &str = r#"
query($owner: String!, $name: String!, $states: [PullRequestState!]) {
  repository(owner: $owner, name: $name) {
    pullRequests(first: 80, states: $states, orderBy: {field: UPDATED_AT, direction: DESC}) {
      nodes {
        databaseId
        number
        title
        body
        url
        isDraft
        state
        mergedAt
        updatedAt
        additions
        deletions
        comments { totalCount }
        author { login }
        assignees(first: 10) { nodes { login } }
        labels(first: 20) { nodes { name } }
        headRefName
        baseRefName
        mergeable
        mergeStateStatus
        reviewDecision
        latestReviews(first: 40) { nodes { author { login } state } }
        reviewRequests(first: 20) {
          nodes {
            requestedReviewer {
              ... on User { login }
              ... on Team { name }
            }
          }
        }
        commits(last: 1) {
          nodes {
            commit {
              statusCheckRollup {
                state
                contexts(first: 80) {
                  nodes {
                    ... on CheckRun { name status conclusion }
                    ... on StatusContext { context state }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
}
"#;

#[derive(Debug, Deserialize)]
struct GqlError {
    #[serde(default)]
    message: String,
}

#[derive(Debug, Deserialize)]
struct GqlEnvelope {
    data: Option<GqlData>,
    #[serde(default)]
    errors: Option<Vec<GqlError>>,
}

#[derive(Debug, Deserialize)]
struct GqlData {
    repository: Option<GqlRepository>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GqlRepository {
    pull_requests: GqlPrConnection,
}

#[derive(Debug, Deserialize)]
struct GqlPrConnection {
    nodes: Vec<Option<GqlPullRequest>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GqlLogin {
    login: Option<String>,
}

#[derive(Debug, Deserialize)]
struct GqlCount {
    #[serde(rename = "totalCount", default)]
    total_count: u32,
}

#[derive(Debug, Deserialize)]
#[serde(bound(deserialize = "T: Deserialize<'de>"))]
struct GqlNodes<T> {
    #[serde(default)]
    nodes: Vec<T>,
}

#[derive(Debug, Deserialize)]
struct GqlReviewerNode {
    #[serde(rename = "requestedReviewer")]
    requested_reviewer: Option<GqlRequestedReviewer>,
}

#[derive(Debug, Deserialize)]
struct GqlRequestedReviewer {
    #[serde(default)]
    login: Option<String>,
    #[serde(default)]
    name: Option<String>,
}

#[derive(Debug, Deserialize)]
struct GqlReviewNode {
    author: Option<GqlLogin>,
    #[serde(default)]
    state: String,
}

#[derive(Debug, Deserialize)]
struct GqlCheckContext {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    status: Option<String>,
    #[serde(default)]
    conclusion: Option<String>,
    #[serde(default)]
    context: Option<String>,
    #[serde(default)]
    state: Option<String>,
}

#[derive(Debug, Deserialize)]
struct GqlRollup {
    #[serde(default)]
    state: Option<String>,
    #[serde(default)]
    contexts: Option<GqlNodes<GqlCheckContext>>,
}

#[derive(Debug, Deserialize)]
struct GqlCommitInner {
    #[serde(rename = "statusCheckRollup")]
    status_check_rollup: Option<GqlRollup>,
}

#[derive(Debug, Deserialize)]
struct GqlCommitNode {
    commit: Option<GqlCommitInner>,
}

#[derive(Debug, Deserialize)]
struct GqlCommits {
    #[serde(default)]
    nodes: Vec<Option<GqlCommitNode>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GqlPullRequest {
    database_id: Option<u64>,
    number: u32,
    title: String,
    #[serde(default)]
    body: String,
    url: String,
    #[serde(default)]
    is_draft: bool,
    #[serde(default)]
    state: String,
    merged_at: Option<String>,
    #[serde(default)]
    updated_at: String,
    #[serde(default)]
    additions: u32,
    #[serde(default)]
    deletions: u32,
    comments: Option<GqlCount>,
    author: Option<GqlLogin>,
    assignees: Option<GqlNodes<GqlLogin>>,
    labels: Option<GqlNodes<GqlLabel>>,
    head_ref_name: Option<String>,
    base_ref_name: Option<String>,
    mergeable: Option<String>,
    merge_state_status: Option<String>,
    review_decision: Option<String>,
    #[serde(rename = "latestReviews")]
    reviews: Option<GqlNodes<GqlReviewNode>>,
    review_requests: Option<GqlNodes<GqlReviewerNode>>,
    commits: Option<GqlCommits>,
}

#[derive(Debug, Deserialize)]
struct GqlLabel {
    name: Option<String>,
}

fn list_github_prs_graphql(
    client: &reqwest::blocking::Client,
    base: &str,
    token: &str,
    owner: &str,
    repo: &str,
    me: &str,
    input: &ListPullRequestsInput,
) -> AppResult<Vec<MockPullRequest>> {
    let url = github_graphql_url(base);
    let body = serde_json::json!({
        "query": GITHUB_PR_QUERY,
        "variables": {
            "owner": owner,
            "name": repo,
            "states": github_pr_states(input),
        }
    });
    let response = client
        .post(&url)
        .header("Accept", "application/vnd.github+json")
        .header("User-Agent", "Branchline")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .bearer_auth(token)
        .json(&body)
        .send()
        .map_err(|e| AppError::msg(format!("GitHub PR query failed: {e}")))?;
    let status = response.status();
    if !status.is_success() {
        let text = response.text().unwrap_or_default();
        return Err(AppError::msg(format!(
            "Could not list pull requests ({status}). {text}"
        )));
    }
    let envelope: GqlEnvelope = response
        .json()
        .map_err(|e| AppError::msg(format!("Could not parse pull requests: {e}")))?;
    if envelope.data.as_ref().and_then(|d| d.repository.as_ref()).is_none() {
        let detail = envelope
            .errors
            .unwrap_or_default()
            .into_iter()
            .map(|e| e.message)
            .filter(|m| !m.is_empty())
            .collect::<Vec<_>>()
            .join(" ");
        return Err(AppError::msg(if detail.is_empty() {
            "GitHub GraphQL returned no repository data.".into()
        } else {
            detail
        }));
    }
    let nodes = envelope
        .data
        .and_then(|d| d.repository)
        .map(|r| r.pull_requests.nodes)
        .unwrap_or_default();
    Ok(nodes
        .into_iter()
        .flatten()
        .map(|pr| map_gql_pr(pr, repo, me))
        .collect())
}

fn map_gql_pr(pr: GqlPullRequest, repo: &str, me: &str) -> MockPullRequest {
    let author = pr
        .author
        .and_then(|u| u.login)
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "unknown".into());
    let assignees = pr
        .assignees
        .map(|n| {
            n.nodes
                .into_iter()
                .filter_map(|u| u.login)
                .filter(|s| !s.is_empty())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let labels = pr
        .labels
        .map(|n| {
            n.nodes
                .into_iter()
                .filter_map(|l| l.name)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let requested: Vec<String> = pr
        .review_requests
        .map(|n| {
            n.nodes
                .into_iter()
                .filter_map(|node| {
                    let reviewer = node.requested_reviewer?;
                    reviewer
                        .login
                        .filter(|s| !s.is_empty())
                        .or_else(|| reviewer.name.filter(|s| !s.is_empty()))
                })
                .collect()
        })
        .unwrap_or_default();
    let reviews: Vec<GqlReviewNode> = pr
        .reviews
        .map(|n| n.nodes)
        .unwrap_or_default();
    let (approvals, changes_requested, approved_by, requested_changes_by) =
        summarize_reviews(reviews.iter().map(|r| {
            (
                r.author
                    .as_ref()
                    .and_then(|a| a.login.clone())
                    .unwrap_or_default(),
                r.state.as_str(),
            )
        }));
    let mut reviewers = requested.clone();
    for name in approved_by.iter().chain(requested_changes_by.iter()) {
        if !reviewers.iter().any(|r| r.eq_ignore_ascii_case(name)) {
            reviewers.push(name.clone());
        }
    }
    let status = if pr.merged_at.is_some() || pr.state.eq_ignore_ascii_case("MERGED") {
        "merged".to_string()
    } else if pr.state.eq_ignore_ascii_case("CLOSED") {
        "closed".to_string()
    } else {
        "open".to_string()
    };
    let rollup = pr
        .commits
        .and_then(|c| c.nodes.into_iter().flatten().next())
        .and_then(|n| n.commit)
        .and_then(|c| c.status_check_rollup);
    let (check_passed, check_failed, check_pending, check_total, pipeline_status, check_summary) =
        summarize_checks(rollup.as_ref());
    let merge_state = pr
        .merge_state_status
        .or(pr.mergeable.clone())
        .unwrap_or_default()
        .to_ascii_lowercase();
    let mergeable = match pr.mergeable.as_deref().map(|s| s.to_ascii_uppercase()) {
        Some(ref s) if s == "MERGEABLE" => Some(true),
        Some(ref s) if s == "CONFLICTING" => Some(false),
        _ => None,
    };
    let review_state = match pr
        .review_decision
        .as_deref()
        .unwrap_or("")
        .to_ascii_uppercase()
        .as_str()
    {
        "CHANGES_REQUESTED" => "changesRequested".into(),
        "APPROVED" => "approved".into(),
        "REVIEW_REQUIRED" => "pending".into(),
        _ if changes_requested > 0 => "changesRequested".into(),
        _ if approvals > 0 => "approved".into(),
        _ => "pending".into(),
    };
    let needs_my_review = !me.is_empty()
        && requested
            .iter()
            .any(|r| r.eq_ignore_ascii_case(me));
    let mut mapped = MockPullRequest {
        id: format!("gh-{}", pr.database_id.unwrap_or(pr.number as u64)),
        number: pr.number,
        title: pr.title,
        author: author.clone(),
        assignees,
        reviewers,
        team: String::new(),
        repo: repo.to_string(),
        source_branch: pr.head_ref_name.unwrap_or_default(),
        target_branch: pr.base_ref_name.unwrap_or_default(),
        status,
        url: pr.url,
        labels,
        updated_at: pr.updated_at,
        draft: pr.is_draft,
        review_state,
        pipeline_status,
        additions: pr.additions,
        deletions: pr.deletions,
        comment_count: pr.comments.map(|c| c.total_count).unwrap_or(0),
        is_mine: !me.is_empty() && author.eq_ignore_ascii_case(me),
        needs_my_review,
        approvals,
        changes_requested,
        pending_reviewers: requested.len() as u32,
        approved_by,
        requested_changes_by,
        check_passed,
        check_failed,
        check_pending,
        check_total,
        mergeable,
        merge_state,
        check_summary,
        body: pr.body,
        ..Default::default()
    };
    finalize_pr_insights(&mut mapped);
    mapped
}

fn summarize_reviews<'a, I>(reviews: I) -> (u32, u32, Vec<String>, Vec<String>)
where
    I: Iterator<Item = (String, &'a str)>,
{
    let mut latest: HashMap<String, (String, String)> = HashMap::new();
    for (login, state) in reviews {
        let login = login.trim();
        if login.is_empty() {
            continue;
        }
        let key = login.to_ascii_lowercase();
        latest.insert(key, (login.to_string(), state.to_ascii_uppercase()));
    }
    let mut approved_by = Vec::new();
    let mut requested_changes_by = Vec::new();
    for (_, (name, state)) in latest {
        match state.as_str() {
            "APPROVED" => approved_by.push(name),
            "CHANGES_REQUESTED" => requested_changes_by.push(name),
            _ => {}
        }
    }
    approved_by.sort();
    requested_changes_by.sort();
    (
        approved_by.len() as u32,
        requested_changes_by.len() as u32,
        approved_by,
        requested_changes_by,
    )
}

fn check_context_name(ctx: &GqlCheckContext) -> String {
    ctx.name
        .clone()
        .filter(|s| !s.is_empty())
        .or_else(|| ctx.context.clone().filter(|s| !s.is_empty()))
        .unwrap_or_default()
}

fn clip_check_names(names: &[String]) -> String {
    const MAX: usize = 3;
    let mut shown: Vec<String> = names.iter().take(MAX).cloned().collect();
    if names.len() > MAX {
        shown.push(format!("+{}", names.len() - MAX));
    }
    shown.join(", ")
}

fn format_check_summary(
    passed: u32,
    failed_names: &[String],
    pending_names: &[String],
    total: u32,
) -> String {
    if total == 0 {
        return String::new();
    }
    if !failed_names.is_empty() {
        return format!(
            "{} failing · {passed}/{total} checks",
            clip_check_names(failed_names)
        );
    }
    if !pending_names.is_empty() {
        return format!(
            "{} running · {passed}/{total} checks",
            clip_check_names(pending_names)
        );
    }
    format!("{passed}/{total} checks")
}

fn summarize_checks(rollup: Option<&GqlRollup>) -> (u32, u32, u32, u32, String, String) {
    let Some(rollup) = rollup else {
        return (0, 0, 0, 0, "unknown".into(), String::new());
    };
    let mut passed = 0u32;
    let mut failed = 0u32;
    let mut pending = 0u32;
    let mut failed_names = Vec::new();
    let mut pending_names = Vec::new();
    for ctx in rollup
        .contexts
        .as_ref()
        .map(|c| c.nodes.iter())
        .into_iter()
        .flatten()
    {
        let name = check_context_name(ctx);
        if ctx.name.is_some() || ctx.context.is_some() || ctx.conclusion.is_some() || ctx.status.is_some() {
            let status = ctx.status.as_deref().unwrap_or("").to_ascii_uppercase();
            let conclusion = ctx.conclusion.as_deref().unwrap_or("").to_ascii_uppercase();
            if status != "COMPLETED" && status != "" {
                pending += 1;
                if !name.is_empty() {
                    pending_names.push(name);
                }
            } else if matches!(
                conclusion.as_str(),
                "SUCCESS" | "NEUTRAL" | "SKIPPED"
            ) {
                passed += 1;
            } else if conclusion.is_empty() {
                pending += 1;
                if !name.is_empty() {
                    pending_names.push(name);
                }
            } else {
                failed += 1;
                if !name.is_empty() {
                    failed_names.push(name);
                }
            }
        } else if let Some(state) = ctx.state.as_deref() {
            match state.to_ascii_uppercase().as_str() {
                "SUCCESS" => passed += 1,
                "PENDING" | "EXPECTED" => {
                    pending += 1;
                    if !name.is_empty() {
                        pending_names.push(name);
                    }
                }
                _ => {
                    failed += 1;
                    if !name.is_empty() {
                        failed_names.push(name);
                    }
                }
            }
        }
    }
    let total = passed + failed + pending;
    let pipeline = if failed > 0 {
        "failure"
    } else if pending > 0 {
        "pending"
    } else if passed > 0 {
        "success"
    } else {
        match rollup.state.as_deref().unwrap_or("").to_ascii_uppercase().as_str() {
            "SUCCESS" => "success",
            "PENDING" | "EXPECTED" => "pending",
            "FAILURE" | "ERROR" => "failure",
            _ => "unknown",
        }
    };
    let summary = format_check_summary(passed, &failed_names, &pending_names, total);
    (passed, failed, pending, total, pipeline.into(), summary)
}

fn finalize_pr_insights(pr: &mut MockPullRequest) {
    if pr.review_state == "unknown" || pr.review_state.is_empty() {
        pr.review_state = if pr.changes_requested > 0 {
            "changesRequested".into()
        } else if pr.approvals > 0 {
            "approved".into()
        } else {
            "pending".into()
        };
    }
    if pr.pipeline_status == "unknown" || pr.pipeline_status.is_empty() {
        pr.pipeline_status = if pr.check_failed > 0 {
            "failure".into()
        } else if pr.check_pending > 0 {
            "pending".into()
        } else if pr.check_passed > 0 {
            "success".into()
        } else {
            "unknown".into()
        };
    }
    if pr.check_summary.is_empty() {
        if pr.check_total > 0 {
            pr.check_summary = format!("{}/{} checks", pr.check_passed, pr.check_total);
        } else if pr.pipeline_status != "unknown" {
            pr.check_summary = match pr.pipeline_status.as_str() {
                "success" => "Checks passed".into(),
                "failure" => "Checks failing".into(),
                "pending" => "Checks running".into(),
                "cancelled" => "Checks cancelled".into(),
                _ => String::new(),
            };
        }
    }
    let checks_ok = pr.check_failed == 0 && pr.check_pending == 0;
    let merge_ok = match pr.merge_state.to_ascii_lowercase().as_str() {
        "dirty" | "blocked" | "conflicting" | "behind" => false,
        _ => pr.mergeable != Some(false),
    };
    pr.ready_to_merge = pr.status == "open"
        && !pr.draft
        && pr.changes_requested == 0
        && pr.approvals > 0
        && checks_ok
        && merge_ok;
}

fn list_github_prs_rest(
    client: &reqwest::blocking::Client,
    base: &str,
    token: &str,
    owner: &str,
    repo: &str,
    me: &str,
    input: &ListPullRequestsInput,
) -> AppResult<Vec<MockPullRequest>> {
    let full = format!("{owner}/{repo}");
    let state_q = match input.state.as_deref().map(str::trim).unwrap_or("open") {
        "all" => "all",
        "closed" => "closed",
        _ => "open",
    };
    let url = format!(
        "{base}/repos/{full}/pulls?state={state_q}&per_page=100&page=1&sort=updated&direction=desc"
    );
    let response = github_get(client, token, &url)?;
    let batch: Vec<GhPr> = response
        .json()
        .map_err(|e| AppError::msg(format!("Could not parse pull requests: {e}")))?;
    let mut mapped: Vec<(MockPullRequest, String)> = batch
        .into_iter()
        .map(|pr| {
            let sha = pr
                .head
                .as_ref()
                .and_then(|h| h.sha.clone())
                .unwrap_or_default();
            (map_pr(pr, repo, me), sha)
        })
        .collect();
    for chunk in mapped.chunks_mut(8) {
        std::thread::scope(|s| {
            for (pr, sha) in chunk {
                let sha = sha.clone();
                let full = full.clone();
                s.spawn(move || {
                    enrich_github_pr_rest(client, base, token, &full, pr, &sha);
                });
            }
        });
    }
    Ok(mapped.into_iter().map(|(pr, _)| pr).collect())
}

fn github_get(
    client: &reqwest::blocking::Client,
    token: &str,
    url: &str,
) -> AppResult<reqwest::blocking::Response> {
    let response = client
        .get(url)
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
    Ok(response)
}

#[derive(Debug, Deserialize)]
struct GhReview {
    user: Option<GhUser>,
    #[serde(default)]
    state: String,
}

#[derive(Debug, Deserialize)]
struct GhCheckRuns {
    #[serde(default)]
    check_runs: Vec<GhCheckRun>,
}

#[derive(Debug, Deserialize)]
struct GhCheckRun {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    status: Option<String>,
    #[serde(default)]
    conclusion: Option<String>,
}

fn enrich_github_pr_rest(
    client: &reqwest::blocking::Client,
    base: &str,
    token: &str,
    full: &str,
    pr: &mut MockPullRequest,
    sha: &str,
) {
    let reviews_url = format!("{base}/repos/{full}/pulls/{}/reviews?per_page=100", pr.number);
    if let Ok(response) = client
        .get(&reviews_url)
        .header("Accept", "application/vnd.github+json")
        .header("User-Agent", "Branchline")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .bearer_auth(token)
        .send()
    {
        if response.status().is_success() {
            if let Ok(reviews) = response.json::<Vec<GhReview>>() {
                let (approvals, changes_requested, approved_by, requested_changes_by) =
                    summarize_reviews(reviews.iter().map(|r| {
                        (
                            r.user
                                .as_ref()
                                .map(|u| u.login.clone())
                                .unwrap_or_default(),
                            r.state.as_str(),
                        )
                    }));
                pr.approvals = approvals;
                pr.changes_requested = changes_requested;
                pr.approved_by = approved_by;
                pr.requested_changes_by = requested_changes_by;
                pr.review_state = String::new();
            }
        }
    }
    if !sha.is_empty() {
        let checks_url = format!("{base}/repos/{full}/commits/{sha}/check-runs?per_page=100");
        if let Ok(response) = client
            .get(&checks_url)
            .header("Accept", "application/vnd.github+json")
            .header("User-Agent", "Branchline")
            .header("X-GitHub-Api-Version", "2022-11-28")
            .bearer_auth(token)
            .send()
        {
            if response.status().is_success() {
                if let Ok(payload) = response.json::<GhCheckRuns>() {
                    let mut passed = 0u32;
                    let mut failed = 0u32;
                    let mut pending = 0u32;
                    let mut failed_names = Vec::new();
                    let mut pending_names = Vec::new();
                    for run in payload.check_runs {
                        let name = run.name.unwrap_or_default();
                        let status = run.status.unwrap_or_default().to_ascii_lowercase();
                        let conclusion = run.conclusion.unwrap_or_default().to_ascii_lowercase();
                        if status != "completed" {
                            pending += 1;
                            if !name.is_empty() {
                                pending_names.push(name);
                            }
                        } else if matches!(
                            conclusion.as_str(),
                            "success" | "neutral" | "skipped"
                        ) {
                            passed += 1;
                        } else {
                            failed += 1;
                            if !name.is_empty() {
                                failed_names.push(name);
                            }
                        }
                    }
                    pr.check_passed = passed;
                    pr.check_failed = failed;
                    pr.check_pending = pending;
                    pr.check_total = passed + failed + pending;
                    pr.pipeline_status = String::new();
                    pr.check_summary =
                        format_check_summary(passed, &failed_names, &pending_names, pr.check_total);
                }
            }
        }
    }
    finalize_pr_insights(pr);
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
    description: Option<String>,
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
    let pending_reviewers = reviewers.len() as u32;
    let mut mapped = MockPullRequest {
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
        pending_reviewers,
        body: mr.description.unwrap_or_default(),
        ..Default::default()
    };
    finalize_pr_insights(&mut mapped);
    mapped
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
    #[serde(default)]
    vote: Option<i32>,
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
    description: Option<String>,
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
    let mut reviewers = Vec::new();
    let mut approved_by = Vec::new();
    let mut requested_changes_by = Vec::new();
    for r in pr.reviewers.unwrap_or_default() {
        let name = r
            .display_name
            .filter(|s| !s.is_empty())
            .or(r.unique_name)
            .unwrap_or_else(|| "unknown".into());
        let vote = r.vote.unwrap_or(0);
        if vote >= 5 {
            approved_by.push(name.clone());
        } else if vote <= -5 {
            requested_changes_by.push(name.clone());
        }
        reviewers.push(name);
    }
    let needs_my_review = !me.is_empty()
        && reviewers
            .iter()
            .any(|r| r.eq_ignore_ascii_case(me))
        && !approved_by.iter().any(|r| r.eq_ignore_ascii_case(me));
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
    let mut mapped = MockPullRequest {
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
        approvals: approved_by.len() as u32,
        changes_requested: requested_changes_by.len() as u32,
        pending_reviewers: reviewers
            .iter()
            .filter(|name| {
                !approved_by.iter().any(|a| a.eq_ignore_ascii_case(name))
                    && !requested_changes_by.iter().any(|a| a.eq_ignore_ascii_case(name))
            })
            .count() as u32,
        approved_by,
        requested_changes_by,
        body: pr.description.unwrap_or_default(),
        ..Default::default()
    };
    finalize_pr_insights(&mut mapped);
    mapped
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

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewPullRequestInput {
    pub path: String,
    pub number: u32,
    pub event: String,
    #[serde(default)]
    pub body: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MergePullRequestInput {
    pub path: String,
    pub number: u32,
    #[serde(default)]
    pub merge_method: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdatePullRequestInput {
    pub path: String,
    pub number: u32,
    #[serde(default)]
    pub state: Option<String>,
    #[serde(default)]
    pub ready: Option<bool>,
    #[serde(default)]
    pub assign_me: Option<bool>,
    #[serde(default)]
    pub request_my_review: Option<bool>,
}

fn resolve_github_for_path(
    settings: &AppSettings,
    path: &PathBuf,
) -> AppResult<(ConnectionConfig, String, String)> {
    match resolve_pr_target(path, settings, None)? {
        PrTarget::Github(connection, owner, repo) => Ok((connection, owner, repo)),
        PrTarget::Gitlab(_, _) => Err(AppError::msg(
            "Review and merge from Branchline are available for GitHub PRs. Open this merge request in the browser.",
        )),
        PrTarget::Azure(_, _, _, _) => Err(AppError::msg(
            "Review and merge from Branchline are available for GitHub PRs. Open this pull request in the browser.",
        )),
    }
}

fn github_json(
    client: &reqwest::blocking::Client,
    token: &str,
    method: reqwest::Method,
    url: &str,
    body: Option<serde_json::Value>,
) -> AppResult<reqwest::blocking::Response> {
    let mut req = client
        .request(method, url)
        .header("Accept", "application/vnd.github+json")
        .header("User-Agent", "Branchline")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .bearer_auth(token);
    if let Some(body) = body {
        req = req.json(&body);
    }
    req.send()
        .map_err(|e| AppError::msg(format!("GitHub request failed: {e}")))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListPullRequestCommentsInput {
    pub path: String,
    pub number: u32,
    #[serde(default)]
    pub connection_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrComment {
    pub id: String,
    pub kind: String,
    pub author: String,
    pub body: String,
    pub created_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub line: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub diff_hunk: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub review_state: Option<String>,
    #[serde(default)]
    pub resolved: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrCommentThread {
    pub id: String,
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub line: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub diff_hunk: Option<String>,
    #[serde(default)]
    pub resolved: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub review_state: Option<String>,
    pub comments: Vec<PrComment>,
}

fn pr_comment(
    id: impl Into<String>,
    kind: &str,
    author: impl Into<String>,
    body: impl Into<String>,
    created_at: impl Into<String>,
) -> PrComment {
    PrComment {
        id: id.into(),
        kind: kind.into(),
        author: author.into(),
        body: body.into(),
        created_at: created_at.into(),
        path: None,
        line: None,
        diff_hunk: None,
        review_state: None,
        resolved: false,
    }
}

const GITHUB_PR_COMMENTS_QUERY: &str = r#"
query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      comments(first: 60) {
        nodes { id author { login } body createdAt }
      }
      reviews(first: 40) {
        nodes { id author { login } body state submittedAt }
      }
    }
  }
}
"#;

const GITHUB_PR_CODE_THREADS_QUERY: &str = r#"
query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 50) {
        nodes {
          id
          isResolved
          comments(first: 30) {
            nodes {
              id
              author { login }
              body
              createdAt
              path
              line
              originalLine
              diffHunk
            }
          }
        }
      }
    }
  }
}
"#;

#[derive(Debug, Deserialize)]
struct GqlConvEnvelope {
    data: Option<GqlConvData>,
    #[serde(default)]
    errors: Option<Vec<GqlError>>,
}

#[derive(Debug, Deserialize)]
struct GqlConvData {
    repository: Option<GqlConvRepo>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GqlConvRepo {
    pull_request: Option<GqlConvPr>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GqlConvPr {
    comments: Option<GqlNodes<GqlConvComment>>,
    reviews: Option<GqlNodes<GqlConvReview>>,
    review_threads: Option<GqlNodes<GqlConvThread>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GqlConvComment {
    id: Option<String>,
    author: Option<GqlLogin>,
    #[serde(default)]
    body: String,
    #[serde(default)]
    created_at: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GqlConvReview {
    id: Option<String>,
    author: Option<GqlLogin>,
    #[serde(default)]
    body: String,
    #[serde(default)]
    state: String,
    submitted_at: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GqlConvThread {
    id: Option<String>,
    #[serde(default)]
    is_resolved: bool,
    comments: Option<GqlNodes<GqlConvThreadComment>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GqlConvThreadComment {
    id: Option<String>,
    author: Option<GqlLogin>,
    #[serde(default)]
    body: String,
    #[serde(default)]
    created_at: String,
    #[serde(default)]
    path: Option<String>,
    #[serde(default)]
    line: Option<i32>,
    #[serde(default)]
    original_line: Option<i32>,
    #[serde(default)]
    diff_hunk: Option<String>,
}

fn gql_author(author: Option<GqlLogin>) -> String {
    author
        .and_then(|a| a.login)
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "unknown".into())
}

#[command]
pub async fn list_pull_request_comments(
    state: State<'_, AppState>,
    input: ListPullRequestCommentsInput,
) -> AppResult<Vec<PrCommentThread>> {
    let settings = load_settings_with_tokens(&state)?;
    run_blocking(move || list_pull_request_comments_inner(settings, input)).await
}

fn list_pull_request_comments_inner(
    settings: AppSettings,
    input: ListPullRequestCommentsInput,
) -> AppResult<Vec<PrCommentThread>> {
    let path = PathBuf::from(&input.path);
    match resolve_pr_target(&path, &settings, input.connection_id.as_deref())? {
        PrTarget::Github(connection, owner, repo) => {
            list_github_pr_comments(connection, owner, repo, input.number)
        }
        PrTarget::Gitlab(connection, project) => {
            list_gitlab_mr_comments(connection, project, input.number)
        }
        PrTarget::Azure(connection, org, project, repo) => {
            list_azure_pr_comments(connection, org, project, repo, input.number)
        }
    }
}

fn list_github_pr_comments(
    connection: ConnectionConfig,
    owner: String,
    repo: String,
    number: u32,
) -> AppResult<Vec<PrCommentThread>> {
    let base = connection.base_url.trim().trim_end_matches('/');
    let token = connection.token.trim();
    match list_github_pr_comments_graphql(
        github_graphql_client(),
        base,
        token,
        &owner,
        &repo,
        number,
    ) {
        Ok(threads) => Ok(threads),
        Err(_) => list_github_pr_comments_rest(
            github_http_client(),
            base,
            token,
            &owner,
            &repo,
            number,
        ),
    }
}

fn github_pr_comments_graphql_envelope(
    client: &reqwest::blocking::Client,
    base: &str,
    token: &str,
    query: &str,
    owner: &str,
    repo: &str,
    number: u32,
) -> AppResult<GqlConvEnvelope> {
    let url = github_graphql_url(base);
    let body = serde_json::json!({
        "query": query,
        "variables": { "owner": owner, "name": repo, "number": number },
    });
    let response = client
        .post(&url)
        .header("Accept", "application/vnd.github+json")
        .header("User-Agent", "Branchline")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .bearer_auth(token)
        .json(&body)
        .send()
        .map_err(|e| AppError::msg(format!("GitHub comments query failed: {e}")))?;
    let status = response.status();
    if !status.is_success() {
        let text = response.text().unwrap_or_default();
        return Err(AppError::msg(format!(
            "Could not load pull request comments ({status}). {text}"
        )));
    }
    response
        .json()
        .map_err(|e| AppError::msg(format!("Could not parse pull request comments: {e}")))
}

fn list_github_pr_comments_graphql(
    client: &reqwest::blocking::Client,
    base: &str,
    token: &str,
    owner: &str,
    repo: &str,
    number: u32,
) -> AppResult<Vec<PrCommentThread>> {
    let envelope =
        github_pr_comments_graphql_envelope(client, base, token, GITHUB_PR_COMMENTS_QUERY, owner, repo, number)?;
    let mut pr = envelope
        .data
        .and_then(|d| d.repository)
        .and_then(|r| r.pull_request)
        .ok_or_else(|| {
            let detail = envelope
                .errors
                .unwrap_or_default()
                .into_iter()
                .map(|e| e.message)
                .filter(|m| !m.is_empty())
                .collect::<Vec<_>>()
                .join(" ");
            AppError::msg(if detail.is_empty() {
                "GitHub returned no pull request comments.".into()
            } else {
                detail
            })
        })?;
    if let Ok(code_env) = github_pr_comments_graphql_envelope(
        client,
        base,
        token,
        GITHUB_PR_CODE_THREADS_QUERY,
        owner,
        repo,
        number,
    ) {
        if let Some(code_pr) = code_env
            .data
            .and_then(|d| d.repository)
            .and_then(|r| r.pull_request)
        {
            pr.review_threads = code_pr.review_threads;
        }
    }
    Ok(map_github_graphql_comments(pr))
}

fn map_github_graphql_comments(pr: GqlConvPr) -> Vec<PrCommentThread> {
    let mut threads = Vec::new();
    for node in pr.comments.map(|n| n.nodes).unwrap_or_default() {
        let body = node.body.trim();
        if body.is_empty() {
            continue;
        }
        let id = node.id.clone().unwrap_or_else(|| format!("issue-{}", threads.len()));
        let comment = pr_comment(
            id.clone(),
            "conversation",
            gql_author(node.author),
            node.body,
            node.created_at,
        );
        threads.push(PrCommentThread {
            id,
            kind: "conversation".into(),
            path: None,
            line: None,
            diff_hunk: None,
            resolved: false,
            review_state: None,
            comments: vec![comment],
        });
    }
    for node in pr.reviews.map(|n| n.nodes).unwrap_or_default() {
        let state = node.state.to_ascii_uppercase();
        if state == "PENDING" {
            continue;
        }
        let body = node.body.trim();
        if body.is_empty() && state != "APPROVED" && state != "CHANGES_REQUESTED" {
            continue;
        }
        let id = node.id.clone().unwrap_or_else(|| format!("review-{}", threads.len()));
        let mut comment = pr_comment(
            id.clone(),
            "review",
            gql_author(node.author),
            node.body,
            node.submitted_at.unwrap_or_default(),
        );
        comment.review_state = Some(node.state);
        threads.push(PrCommentThread {
            id,
            kind: "review".into(),
            path: None,
            line: None,
            diff_hunk: None,
            resolved: false,
            review_state: Some(state),
            comments: vec![comment],
        });
    }
    for node in pr.review_threads.map(|n| n.nodes).unwrap_or_default() {
        let comments: Vec<GqlConvThreadComment> = node.comments.map(|n| n.nodes).unwrap_or_default();
        if comments.is_empty() {
            continue;
        }
        let first = &comments[0];
        let path = first.path.clone();
        let line = first.line.or(first.original_line);
        let diff_hunk = first.diff_hunk.clone();
        let id = node
            .id
            .clone()
            .unwrap_or_else(|| format!("thread-{}", threads.len()));
        let mapped: Vec<PrComment> = comments
            .into_iter()
            .map(|c| {
                let mut comment = pr_comment(
                    c.id.unwrap_or_default(),
                    "code",
                    gql_author(c.author),
                    c.body,
                    c.created_at,
                );
                comment.path = c.path.or_else(|| path.clone());
                comment.line = c.line.or(c.original_line).or(line);
                comment.diff_hunk = c.diff_hunk.or_else(|| diff_hunk.clone());
                comment.resolved = node.is_resolved;
                comment
            })
            .collect();
        threads.push(PrCommentThread {
            id,
            kind: "code".into(),
            path,
            line,
            diff_hunk,
            resolved: node.is_resolved,
            review_state: None,
            comments: mapped,
        });
    }
    threads.sort_by(|a, b| {
        let a_at = a.comments.first().map(|c| c.created_at.as_str()).unwrap_or("");
        let b_at = b.comments.first().map(|c| c.created_at.as_str()).unwrap_or("");
        a_at.cmp(b_at)
    });
    threads
}

#[derive(Debug, Deserialize)]
struct GhIssueComment {
    id: u64,
    user: Option<GhUser>,
    #[serde(default)]
    body: String,
    #[serde(default)]
    created_at: String,
}

#[derive(Debug, Deserialize)]
struct GhReviewComment {
    id: u64,
    user: Option<GhUser>,
    #[serde(default)]
    body: String,
    #[serde(default)]
    created_at: String,
    #[serde(default)]
    path: Option<String>,
    #[serde(default)]
    line: Option<i32>,
    #[serde(default)]
    original_line: Option<i32>,
    #[serde(default)]
    diff_hunk: Option<String>,
    #[serde(default)]
    in_reply_to_id: Option<u64>,
}

#[derive(Debug, Deserialize)]
struct GhReviewEvent {
    id: u64,
    user: Option<GhUser>,
    #[serde(default)]
    body: String,
    #[serde(default)]
    state: String,
    submitted_at: Option<String>,
}

fn github_get_json_or_empty<T: DeserializeOwned + Default>(
    client: &reqwest::blocking::Client,
    token: &str,
    url: &str,
    error_label: &str,
) -> AppResult<T> {
    let response = client
        .get(url)
        .header("Accept", "application/vnd.github+json")
        .header("User-Agent", "Branchline")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .bearer_auth(token)
        .send()
        .map_err(|e| AppError::msg(format!("{error_label}: {e}")))?;
    let status = response.status();
    if status == reqwest::StatusCode::NOT_FOUND {
        return Ok(T::default());
    }
    if !status.is_success() {
        let body = response.text().unwrap_or_default();
        return Err(AppError::msg(format!("{error_label} ({status}). {body}")));
    }
    response
        .json()
        .map_err(|e| AppError::msg(format!("{error_label}: {e}")))
}

fn list_github_pr_comments_rest(
    client: &reqwest::blocking::Client,
    base: &str,
    token: &str,
    owner: &str,
    repo: &str,
    number: u32,
) -> AppResult<Vec<PrCommentThread>> {
    let issue_url = format!("{base}/repos/{owner}/{repo}/issues/{number}/comments?per_page=100");
    let review_url = format!("{base}/repos/{owner}/{repo}/pulls/{number}/reviews?per_page=100");
    let code_url = format!("{base}/repos/{owner}/{repo}/pulls/{number}/comments?per_page=100");
    let issue: Vec<GhIssueComment> = github_get_json_or_empty(
        client,
        token,
        &issue_url,
        "Could not load conversation comments",
    )?;
    let reviews: Vec<GhReviewEvent> = github_get_json_or_empty(
        client,
        token,
        &review_url,
        "Could not load review comments",
    )?;
    let code: Vec<GhReviewComment> = github_get_json_or_empty(
        client,
        token,
        &code_url,
        "Could not load code comments",
    )?;
    let mut threads = Vec::new();
    for node in issue {
        if node.body.trim().is_empty() {
            continue;
        }
        let author = node.user.map(|u| u.login).unwrap_or_else(|| "unknown".into());
        let id = format!("issue-{}", node.id);
        let comment = pr_comment(id.clone(), "conversation", author, node.body, node.created_at);
        threads.push(PrCommentThread {
            id,
            kind: "conversation".into(),
            path: None,
            line: None,
            diff_hunk: None,
            resolved: false,
            review_state: None,
            comments: vec![comment],
        });
    }
    for node in reviews {
        let state = node.state.to_ascii_uppercase();
        if state == "PENDING" {
            continue;
        }
        if node.body.trim().is_empty() && state != "APPROVED" && state != "CHANGES_REQUESTED" {
            continue;
        }
        let author = node.user.map(|u| u.login).unwrap_or_else(|| "unknown".into());
        let id = format!("review-{}", node.id);
        let mut comment = pr_comment(
            id.clone(),
            "review",
            author,
            node.body,
            node.submitted_at.unwrap_or_default(),
        );
        comment.review_state = Some(node.state.clone());
        threads.push(PrCommentThread {
            id,
            kind: "review".into(),
            path: None,
            line: None,
            diff_hunk: None,
            resolved: false,
            review_state: Some(state),
            comments: vec![comment],
        });
    }
    let mut by_id: HashMap<u64, GhReviewComment> = HashMap::new();
    let mut children: HashMap<u64, Vec<u64>> = HashMap::new();
    let mut roots = Vec::new();
    for node in code {
        if let Some(parent) = node.in_reply_to_id {
            children.entry(parent).or_default().push(node.id);
        } else {
            roots.push(node.id);
        }
        by_id.insert(node.id, node);
    }
    for root_id in roots {
        let Some(root) = by_id.get(&root_id) else {
            continue;
        };
        let path = root.path.clone();
        let line = root.line.or(root.original_line);
        let diff_hunk = root.diff_hunk.clone();
        let mut ids = vec![root_id];
        if let Some(replies) = children.get(&root_id) {
            ids.extend(replies.iter().copied());
        }
        let comments: Vec<PrComment> = ids
            .into_iter()
            .filter_map(|id| by_id.get(&id))
            .map(|c| {
                let author = c
                    .user
                    .as_ref()
                    .map(|u| u.login.clone())
                    .unwrap_or_else(|| "unknown".into());
                let mut comment = pr_comment(
                    format!("code-{}", c.id),
                    "code",
                    author,
                    c.body.clone(),
                    c.created_at.clone(),
                );
                comment.path = c.path.clone().or_else(|| path.clone());
                comment.line = c.line.or(c.original_line).or(line);
                comment.diff_hunk = c.diff_hunk.clone().or_else(|| diff_hunk.clone());
                comment
            })
            .collect();
        if comments.is_empty() {
            continue;
        }
        threads.push(PrCommentThread {
            id: format!("code-thread-{}", root_id),
            kind: "code".into(),
            path,
            line,
            diff_hunk,
            resolved: false,
            review_state: None,
            comments,
        });
    }
    threads.sort_by(|a, b| {
        let a_at = a.comments.first().map(|c| c.created_at.as_str()).unwrap_or("");
        let b_at = b.comments.first().map(|c| c.created_at.as_str()).unwrap_or("");
        a_at.cmp(b_at)
    });
    Ok(threads)
}

#[derive(Debug, Deserialize)]
struct GlDiscussion {
    id: String,
    #[serde(default)]
    notes: Vec<GlNote>,
}

#[derive(Debug, Deserialize)]
struct GlNote {
    id: u64,
    #[serde(default)]
    body: String,
    #[serde(default)]
    created_at: String,
    #[serde(default)]
    system: bool,
    #[serde(default)]
    author: Option<GlUser>,
    #[serde(default)]
    position: Option<GlPosition>,
}

#[derive(Debug, Deserialize)]
struct GlPosition {
    #[serde(default)]
    new_path: Option<String>,
    #[serde(default)]
    old_path: Option<String>,
    #[serde(default)]
    new_line: Option<i32>,
    #[serde(default)]
    old_line: Option<i32>,
}

fn list_gitlab_mr_comments(
    connection: ConnectionConfig,
    project: String,
    number: u32,
) -> AppResult<Vec<PrCommentThread>> {
    let api = gitlab_api_base(&connection.base_url);
    let token = connection.token.trim();
    let encoded = encode_project_path(&project);
    let url = format!("{api}/projects/{encoded}/merge_requests/{number}/discussions?per_page=100");
    let response = github_http_client()
        .get(&url)
        .header("User-Agent", "Branchline")
        .header("PRIVATE-TOKEN", token)
        .send()
        .map_err(|e| AppError::msg(format!("GitLab comments request failed: {e}")))?;
    let status = response.status();
    if !status.is_success() {
        let body = response.text().unwrap_or_default();
        return Err(AppError::msg(format!(
            "Could not load merge request comments ({status}). {body}"
        )));
    }
    let discussions: Vec<GlDiscussion> = response
        .json()
        .map_err(|e| AppError::msg(format!("Could not parse merge request comments: {e}")))?;
    let mut threads = Vec::new();
    for discussion in discussions {
        let notes: Vec<GlNote> = discussion
            .notes
            .into_iter()
            .filter(|n| !n.system && !n.body.trim().is_empty())
            .collect();
        if notes.is_empty() {
            continue;
        }
        let position = notes.iter().find_map(|n| n.position.as_ref());
        let kind = if position.is_some() { "code" } else { "conversation" };
        let path = position.and_then(|p| p.new_path.clone().or(p.old_path.clone()));
        let line = position.and_then(|p| p.new_line.or(p.old_line));
        let comments = notes
            .into_iter()
            .map(|n| {
                let author = n
                    .author
                    .as_ref()
                    .map(|u| u.username.clone())
                    .filter(|s| !s.is_empty())
                    .unwrap_or_else(|| "unknown".into());
                let mut comment = pr_comment(
                    format!("gl-{}", n.id),
                    kind,
                    author,
                    n.body,
                    n.created_at,
                );
                comment.path = path.clone();
                comment.line = line;
                comment
            })
            .collect::<Vec<_>>();
        threads.push(PrCommentThread {
            id: format!("gl-{}", discussion.id),
            kind: kind.into(),
            path,
            line,
            diff_hunk: None,
            resolved: false,
            review_state: None,
            comments,
        });
    }
    Ok(threads)
}

#[derive(Debug, Deserialize)]
struct AzThreads {
    #[serde(default)]
    value: Vec<AzThread>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AzThread {
    id: Option<i64>,
    #[serde(default)]
    status: Option<String>,
    #[serde(default)]
    comments: Vec<AzComment>,
    #[serde(default)]
    thread_context: Option<AzThreadContext>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AzThreadContext {
    #[serde(default)]
    file_path: Option<String>,
    #[serde(default)]
    right_file_start: Option<AzFileLine>,
    #[serde(default)]
    left_file_start: Option<AzFileLine>,
}

#[derive(Debug, Deserialize)]
struct AzFileLine {
    #[serde(default)]
    line: Option<i32>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AzComment {
    id: Option<i64>,
    #[serde(default)]
    content: Option<String>,
    #[serde(default)]
    comment_type: Option<String>,
    #[serde(default)]
    published_date: Option<String>,
    #[serde(default)]
    author: Option<AzIdentity>,
}

fn list_azure_pr_comments(
    connection: ConnectionConfig,
    org: String,
    project: String,
    repo: String,
    number: u32,
) -> AppResult<Vec<PrCommentThread>> {
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
    let url = format!(
        "{base}/{org}/{project}/_apis/git/repositories/{repo}/pullRequests/{number}/threads?api-version=7.1"
    );
    let response = github_http_client()
        .get(&url)
        .header("User-Agent", "Branchline")
        .header("Accept", "application/json")
        .basic_auth("", Some(token))
        .send()
        .map_err(|e| AppError::msg(format!("Azure DevOps comments request failed: {e}")))?;
    let status = response.status();
    if !status.is_success() {
        let body = response.text().unwrap_or_default();
        return Err(AppError::msg(format!(
            "Could not load pull request comments ({status}). {body}"
        )));
    }
    let payload: AzThreads = response
        .json()
        .map_err(|e| AppError::msg(format!("Could not parse pull request comments: {e}")))?;
    let mut threads = Vec::new();
    for thread in payload.value {
        let status = thread.status.unwrap_or_default().to_ascii_lowercase();
        if status == "unknown" {
            continue;
        }
        let comments: Vec<AzComment> = thread
            .comments
            .into_iter()
            .filter(|c| {
                let kind = c.comment_type.as_deref().unwrap_or("text").to_ascii_lowercase();
                kind != "system" && !c.content.as_deref().unwrap_or("").trim().is_empty()
            })
            .collect();
        if comments.is_empty() {
            continue;
        }
        let path = thread
            .thread_context
            .as_ref()
            .and_then(|ctx| ctx.file_path.clone())
            .filter(|s| !s.is_empty());
        let line = thread.thread_context.as_ref().and_then(|ctx| {
            ctx.right_file_start
                .as_ref()
                .and_then(|l| l.line)
                .or_else(|| ctx.left_file_start.as_ref().and_then(|l| l.line))
        });
        let kind = if path.is_some() { "code" } else { "conversation" };
        let resolved = matches!(status.as_str(), "fixed" | "closed" | "wontfix" | "bydesign");
        let id = thread
            .id
            .map(|n| format!("az-{n}"))
            .unwrap_or_else(|| format!("az-thread-{}", threads.len()));
        let mapped = comments
            .into_iter()
            .map(|c| {
                let mut comment = pr_comment(
                    c.id.map(|n| format!("az-c-{n}")).unwrap_or_default(),
                    kind,
                    az_name(&c.author),
                    c.content.unwrap_or_default(),
                    c.published_date.unwrap_or_default(),
                );
                comment.path = path.clone();
                comment.line = line;
                comment.resolved = resolved;
                comment
            })
            .collect();
        threads.push(PrCommentThread {
            id,
            kind: kind.into(),
            path,
            line,
            diff_hunk: None,
            resolved,
            review_state: None,
            comments: mapped,
        });
    }
    Ok(threads)
}

#[command]
pub async fn review_pull_request(
    state: State<'_, AppState>,
    input: ReviewPullRequestInput,
) -> AppResult<MutationOutputLike> {
    let settings = load_settings_with_tokens(&state)?;
    run_blocking(move || review_pull_request_inner(settings, input)).await
}

fn review_pull_request_inner(
    settings: AppSettings,
    input: ReviewPullRequestInput,
) -> AppResult<MutationOutputLike> {
    let path = PathBuf::from(&input.path);
    let (connection, owner, repo) = resolve_github_for_path(&settings, &path)?;
    let event = match input.event.trim().to_ascii_uppercase().as_str() {
        "APPROVE" | "APPROVED" => "APPROVE",
        "REQUEST_CHANGES" | "CHANGES_REQUESTED" => "REQUEST_CHANGES",
        "COMMENT" | "COMMENTED" => "COMMENT",
        other => {
            return Err(AppError::msg(format!(
                "Unknown review action '{other}'. Use approve, request changes, or comment."
            )));
        }
    };
    let body = input.body.unwrap_or_default();
    if event != "APPROVE" && body.trim().is_empty() {
        return Err(AppError::msg("Add a short note before submitting this review."));
    }
    let base = connection.base_url.trim().trim_end_matches('/');
    let token = connection.token.trim();
    let url = format!("{base}/repos/{owner}/{repo}/pulls/{}/reviews", input.number);
    let payload = serde_json::json!({
        "event": event,
        "body": body,
    });
    let response = github_json(
        github_http_client(),
        token,
        reqwest::Method::POST,
        &url,
        Some(payload),
    )?;
    let status = response.status();
    if !status.is_success() {
        let text = response.text().unwrap_or_default();
        return Err(AppError::msg(format!(
            "Could not submit review on #{} ({status}). {text}",
            input.number
        )));
    }
    let message = match event {
        "APPROVE" => format!("Approved #{}", input.number),
        "REQUEST_CHANGES" => format!("Requested changes on #{}", input.number),
        _ => format!("Commented on #{}", input.number),
    };
    Ok(MutationOutputLike {
        ok: true,
        message,
    })
}

#[command]
pub async fn merge_pull_request(
    state: State<'_, AppState>,
    input: MergePullRequestInput,
) -> AppResult<MutationOutputLike> {
    let settings = load_settings_with_tokens(&state)?;
    run_blocking(move || merge_pull_request_inner(settings, input)).await
}

fn merge_pull_request_inner(
    settings: AppSettings,
    input: MergePullRequestInput,
) -> AppResult<MutationOutputLike> {
    let path = PathBuf::from(&input.path);
    let (connection, owner, repo) = resolve_github_for_path(&settings, &path)?;
    let method = match input
        .merge_method
        .as_deref()
        .unwrap_or("squash")
        .trim()
        .to_ascii_lowercase()
        .as_str()
    {
        "merge" => "merge",
        "rebase" => "rebase",
        _ => "squash",
    };
    let base = connection.base_url.trim().trim_end_matches('/');
    let token = connection.token.trim();
    let url = format!("{base}/repos/{owner}/{repo}/pulls/{}/merge", input.number);
    let payload = serde_json::json!({ "merge_method": method });
    let response = github_json(
        github_http_client(),
        token,
        reqwest::Method::PUT,
        &url,
        Some(payload),
    )?;
    let status = response.status();
    if !status.is_success() {
        let text = response.text().unwrap_or_default();
        return Err(AppError::msg(format!(
            "Could not merge #{} ({status}). {text}",
            input.number
        )));
    }
    Ok(MutationOutputLike {
        ok: true,
        message: format!("Merged #{} ({method})", input.number),
    })
}

#[command]
pub async fn update_pull_request(
    state: State<'_, AppState>,
    input: UpdatePullRequestInput,
) -> AppResult<MutationOutputLike> {
    let settings = load_settings_with_tokens(&state)?;
    run_blocking(move || update_pull_request_inner(settings, input)).await
}

fn github_login_for(connection: &ConnectionConfig) -> AppResult<String> {
    let base = connection.base_url.trim().trim_end_matches('/');
    let token = connection.token.trim();
    let login = resolve_github_login(github_http_client(), base, token, &connection.username);
    if login.is_empty() {
        Err(AppError::msg(
            "Could not determine your GitHub username. Re-link GitHub under Settings → Connections.",
        ))
    } else {
        Ok(login)
    }
}

fn github_mutation_error(response: reqwest::blocking::Response, number: u32, action: &str) -> AppError {
    let status = response.status();
    let text = response.text().unwrap_or_default();
    AppError::msg(format!("Could not {action} #{number} ({status}). {text}"))
}

fn update_pull_request_inner(
    settings: AppSettings,
    input: UpdatePullRequestInput,
) -> AppResult<MutationOutputLike> {
    let path = PathBuf::from(&input.path);
    let (connection, owner, repo) = resolve_github_for_path(&settings, &path)?;
    let base = connection.base_url.trim().trim_end_matches('/');
    let token = connection.token.trim();
    let client = github_http_client();
    if input.assign_me == Some(true) {
        let me = github_login_for(&connection)?;
        let url = format!("{base}/repos/{owner}/{repo}/issues/{}/assignees", input.number);
        let response = github_json(
            client,
            token,
            reqwest::Method::POST,
            &url,
            Some(serde_json::json!({ "assignees": [me] })),
        )?;
        if !response.status().is_success() {
            return Err(github_mutation_error(response, input.number, "assign you to"));
        }
        return Ok(MutationOutputLike {
            ok: true,
            message: format!("Assigned you to #{}", input.number),
        });
    }
    if input.request_my_review == Some(true) {
        let me = github_login_for(&connection)?;
        let url = format!(
            "{base}/repos/{owner}/{repo}/pulls/{}/requested_reviewers",
            input.number
        );
        let response = github_json(
            client,
            token,
            reqwest::Method::POST,
            &url,
            Some(serde_json::json!({ "reviewers": [me] })),
        )?;
        if !response.status().is_success() {
            return Err(github_mutation_error(
                response,
                input.number,
                "request your review on",
            ));
        }
        return Ok(MutationOutputLike {
            ok: true,
            message: format!("Requested your review on #{}", input.number),
        });
    }
    if input.ready == Some(true) {
        let url = format!(
            "{base}/repos/{owner}/{repo}/pulls/{}/ready_for_review",
            input.number
        );
        let response = github_json(client, token, reqwest::Method::POST, &url, Some(serde_json::json!({})))?;
        let status = response.status();
        if !status.is_success() {
            let text = response.text().unwrap_or_default();
            return Err(AppError::msg(format!(
                "Could not mark #{} ready ({status}). {text}",
                input.number
            )));
        }
        return Ok(MutationOutputLike {
            ok: true,
            message: format!("Marked #{} ready for review", input.number),
        });
    }
    let Some(state) = input.state.as_deref().map(str::trim) else {
        return Err(AppError::msg("Nothing to update on this pull request."));
    };
    let state = match state.to_ascii_lowercase().as_str() {
        "closed" | "close" => "closed",
        "open" | "reopen" => "open",
        other => {
            return Err(AppError::msg(format!("Unknown pull request state '{other}'.")));
        }
    };
    let url = format!("{base}/repos/{owner}/{repo}/pulls/{}", input.number);
    let response = github_json(
        client,
        token,
        reqwest::Method::PATCH,
        &url,
        Some(serde_json::json!({ "state": state })),
    )?;
    let status = response.status();
    if !status.is_success() {
        let text = response.text().unwrap_or_default();
        return Err(AppError::msg(format!(
            "Could not update #{} ({status}). {text}",
            input.number
        )));
    }
    Ok(MutationOutputLike {
        ok: true,
        message: if state == "closed" {
            format!("Closed #{}", input.number)
        } else {
            format!("Reopened #{}", input.number)
        },
    })
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MutationOutputLike {
    pub ok: bool,
    pub message: String,
}
