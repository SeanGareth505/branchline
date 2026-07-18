use crate::commands::settings::{load_settings_with_tokens, ConnectionConfig};
use crate::state::AppState;
use crate::{AppError, AppResult};
use serde::{Deserialize, Serialize};
use tauri::command;
use tauri::State;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JiraIssue {
    pub key: String,
    pub summary: String,
    pub status: String,
    pub assignee: String,
    pub priority: String,
    pub issue_type: String,
    pub url: String,
    pub updated_at: String,
    pub labels: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JiraTransition {
    pub id: String,
    pub name: String,
    pub to_status: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListJiraIssuesInput {
    #[serde(default)]
    pub jql: Option<String>,
    #[serde(default)]
    pub max_results: Option<u32>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JiraIssueKeyInput {
    pub issue_key: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransitionJiraIssueInput {
    pub issue_key: String,
    pub transition_id: String,
}

#[derive(Debug, Deserialize)]
struct SearchResponse {
    issues: Vec<RawIssue>,
}

#[derive(Debug, Deserialize)]
struct RawIssue {
    key: String,
    fields: RawFields,
}

#[derive(Debug, Deserialize)]
struct RawFields {
    summary: Option<String>,
    status: Option<NamedField>,
    assignee: Option<AssigneeField>,
    priority: Option<NamedField>,
    issuetype: Option<NamedField>,
    labels: Option<Vec<String>>,
    updated: Option<String>,
}

#[derive(Debug, Deserialize)]
struct NamedField {
    name: String,
}

#[derive(Debug, Deserialize)]
struct AssigneeField {
    #[serde(rename = "displayName")]
    display_name: Option<String>,
}

#[derive(Debug, Deserialize)]
struct TransitionsResponse {
    transitions: Vec<RawTransition>,
}

#[derive(Debug, Deserialize)]
struct RawTransition {
    id: String,
    name: String,
    to: Option<NamedField>,
}

#[command]
pub fn list_jira_issues(
    state: State<'_, AppState>,
    input: Option<ListJiraIssuesInput>,
) -> AppResult<Vec<JiraIssue>> {
    let connection = jira_connection(&state)?;
    let input = input.unwrap_or(ListJiraIssuesInput {
        jql: None,
        max_results: None,
    });
    let jql = input
        .jql
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("assignee = currentUser() OR reporter = currentUser() ORDER BY updated DESC");
    let max_results = input.max_results.unwrap_or(50).clamp(1, 100);

    let base = api_base(&connection);
    let url = format!("{base}/search");
    let body = serde_json::json!({
        "jql": jql,
        "maxResults": max_results,
        "fields": ["summary", "status", "assignee", "priority", "issuetype", "labels", "updated"],
    });

    let response = client()
        .post(&url)
        .basic_auth(connection.username.trim(), Some(connection.token.trim()))
        .header("Accept", "application/json")
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .map_err(|e| AppError::msg(format!("Jira request failed: {e}")))?;

    if !response.status().is_success() {
        let status = response.status();
        let text = response.text().unwrap_or_default();
        return Err(AppError::msg(format!(
            "Jira returned {status}. Check base URL, email, and API token. {text}"
        )));
    }

    let parsed: SearchResponse = response
        .json()
        .map_err(|e| AppError::msg(format!("Could not parse Jira response: {e}")))?;

    let browse = browse_base(&connection);
    Ok(parsed
        .issues
        .into_iter()
        .map(|issue| {
            let fields = issue.fields;
            JiraIssue {
                key: issue.key.clone(),
                summary: fields.summary.unwrap_or_else(|| "(no summary)".into()),
                status: fields
                    .status
                    .map(|s| s.name)
                    .unwrap_or_else(|| "Unknown".into()),
                assignee: fields
                    .assignee
                    .and_then(|a| a.display_name)
                    .unwrap_or_else(|| "Unassigned".into()),
                priority: fields
                    .priority
                    .map(|p| p.name)
                    .unwrap_or_else(|| "None".into()),
                issue_type: fields
                    .issuetype
                    .map(|t| t.name)
                    .unwrap_or_else(|| "Issue".into()),
                url: format!("{browse}/browse/{}", issue.key),
                updated_at: fields.updated.unwrap_or_default(),
                labels: fields.labels.unwrap_or_default(),
            }
        })
        .collect())
}

#[command]
pub fn list_jira_transitions(
    state: State<'_, AppState>,
    input: JiraIssueKeyInput,
) -> AppResult<Vec<JiraTransition>> {
    let connection = jira_connection(&state)?;
    let key = input.issue_key.trim();
    if key.is_empty() {
        return Err(AppError::msg("Issue key is required"));
    }
    let url = format!("{}/issue/{}/transitions", api_base(&connection), key);
    let response = client()
        .get(&url)
        .basic_auth(connection.username.trim(), Some(connection.token.trim()))
        .header("Accept", "application/json")
        .send()
        .map_err(|e| AppError::msg(format!("Jira request failed: {e}")))?;

    if !response.status().is_success() {
        let status = response.status();
        let text = response.text().unwrap_or_default();
        return Err(AppError::msg(format!("Jira returned {status}. {text}")));
    }

    let parsed: TransitionsResponse = response
        .json()
        .map_err(|e| AppError::msg(format!("Could not parse Jira transitions: {e}")))?;

    Ok(parsed
        .transitions
        .into_iter()
        .map(|t| JiraTransition {
            id: t.id,
            name: t.name,
            to_status: t.to.map(|s| s.name).unwrap_or_default(),
        })
        .collect())
}

#[command]
pub fn transition_jira_issue(
    state: State<'_, AppState>,
    input: TransitionJiraIssueInput,
) -> AppResult<()> {
    let connection = jira_connection(&state)?;
    let key = input.issue_key.trim();
    let transition_id = input.transition_id.trim();
    if key.is_empty() || transition_id.is_empty() {
        return Err(AppError::msg("Issue key and transition id are required"));
    }
    let url = format!("{}/issue/{}/transitions", api_base(&connection), key);
    let body = serde_json::json!({ "transition": { "id": transition_id } });
    let response = client()
        .post(&url)
        .basic_auth(connection.username.trim(), Some(connection.token.trim()))
        .header("Accept", "application/json")
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .map_err(|e| AppError::msg(format!("Jira request failed: {e}")))?;

    if !response.status().is_success() {
        let status = response.status();
        let text = response.text().unwrap_or_default();
        return Err(AppError::msg(format!("Jira returned {status}. {text}")));
    }
    Ok(())
}

fn jira_connection(state: &State<'_, AppState>) -> AppResult<ConnectionConfig> {
    let settings = load_settings_with_tokens(state)?;
    settings
        .connections
        .into_iter()
        .find(|c| {
            c.provider == "jira"
                && c.enabled
                && !c.token.trim().is_empty()
                && !c.username.trim().is_empty()
                && !c.base_url.trim().is_empty()
        })
        .ok_or_else(|| {
            AppError::msg(
                "Jira is not linked. Enable Jira under Settings → Connections and set email + API token.",
            )
        })
}

fn api_base(connection: &ConnectionConfig) -> String {
    let base = connection.base_url.trim().trim_end_matches('/');
    if base.ends_with("/rest/api/3") {
        base.to_string()
    } else if base.ends_with("/rest/api/2") {
        base.trim_end_matches("/rest/api/2").to_string() + "/rest/api/3"
    } else {
        format!("{base}/rest/api/3")
    }
}

fn browse_base(connection: &ConnectionConfig) -> String {
    let base = connection.base_url.trim().trim_end_matches('/');
    base.trim_end_matches("/rest/api/3")
        .trim_end_matches("/rest/api/2")
        .trim_end_matches('/')
        .to_string()
}

fn client() -> reqwest::blocking::Client {
    reqwest::blocking::Client::new()
}
