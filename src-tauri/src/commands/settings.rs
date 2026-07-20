use crate::infrastructure::sqlite;
use crate::state::AppState;
use crate::{AppError, AppResult};
use serde::{Deserialize, Serialize};
use tauri::command;
use tauri::State;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionConfig {
    pub id: String,
    pub provider: String,
    pub label: String,
    pub enabled: bool,
    pub base_url: String,
    pub username: String,
    pub token: String,
    #[serde(default)]
    pub organization: String,
    #[serde(default)]
    pub project: String,
    #[serde(default)]
    pub has_token: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitTypeOption {
    pub id: String,
    pub label: String,
    #[serde(default)]
    pub description: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    pub theme: String,
    pub accent: String,
    pub simple_mode: bool,
    pub layout: serde_json::Value,
    pub focus_mode: bool,
    #[serde(default = "default_pull_action")]
    pub default_pull_action: String,
    #[serde(default = "default_push_action")]
    pub default_push_action: String,
    #[serde(default)]
    pub auto_fetch_on_open: bool,
    #[serde(default = "default_true")]
    pub confirm_force_push: bool,
    #[serde(default = "default_true")]
    pub confirm_discard: bool,
    #[serde(default = "default_true")]
    pub confirm_push_new_branch: bool,
    #[serde(default = "default_true")]
    pub confirm_add_tracking_ref: bool,
    #[serde(default = "default_true")]
    pub confirm_amend: bool,
    #[serde(default = "default_true")]
    pub confirm_undo_last_commit: bool,
    #[serde(default = "default_true")]
    pub confirm_stash_drop: bool,
    #[serde(default = "default_true")]
    pub confirm_abort_operation: bool,
    #[serde(default = "default_true")]
    pub confirm_abort_second: bool,
    #[serde(default = "default_true")]
    pub confirm_remove_remote: bool,
    #[serde(default)]
    pub sign_off_by_default: bool,
    #[serde(default)]
    pub push_after_commit: bool,
    #[serde(default)]
    pub my_branches_only: bool,
    #[serde(default = "default_true")]
    pub branch_prefix_enabled: bool,
    #[serde(default = "default_branch_prefix")]
    pub branch_prefix: String,
    #[serde(default)]
    pub branch_prefixes: Vec<String>,
    #[serde(default = "default_preferred_editor")]
    pub preferred_editor: String,
    #[serde(default)]
    pub editor_command: String,
    #[serde(default)]
    pub diff_tool: String,
    #[serde(default)]
    pub merge_tool: String,
    #[serde(default = "default_ssh_client")]
    pub ssh_client: String,
    #[serde(default = "default_connections")]
    pub connections: Vec<ConnectionConfig>,
    #[serde(default = "default_commit_types")]
    pub commit_types: Vec<CommitTypeOption>,
    #[serde(default)]
    pub github_oauth_client_id: String,
    #[serde(default = "default_true")]
    pub notifications_enabled: bool,
    #[serde(default = "default_true")]
    pub notify_toasts: bool,
    #[serde(default = "default_true")]
    pub notify_desktop: bool,
    #[serde(default)]
    pub notify_git_fetch: bool,
    #[serde(default = "default_true")]
    pub notify_git_pull: bool,
    #[serde(default = "default_true")]
    pub notify_git_push: bool,
    #[serde(default = "default_true")]
    pub notify_git_commit: bool,
    #[serde(default = "default_true")]
    pub notify_git_conflicts: bool,
    #[serde(default = "default_true")]
    pub notify_remote_behind: bool,
    #[serde(default = "default_true")]
    pub notify_app_updates: bool,
    #[serde(default = "default_true")]
    pub notify_pr_activity: bool,
    #[serde(default = "default_true")]
    pub notify_pr_ci: bool,
}

fn default_pull_action() -> String {
    "merge".into()
}

fn default_push_action() -> String {
    "upstream".into()
}

fn default_ssh_client() -> String {
    "openssh".into()
}

fn default_true() -> bool {
    true
}

fn default_branch_prefix() -> String {
    "feature".into()
}

fn default_branch_prefixes() -> Vec<String> {
    vec![
        "feature".into(),
        "bugfix".into(),
        "hotfix".into(),
        "chore".into(),
        "release".into(),
    ]
}

fn default_preferred_editor() -> String {
    "auto".into()
}

fn default_commit_types() -> Vec<CommitTypeOption> {
    vec![
        CommitTypeOption {
            id: "feat".into(),
            label: "feat".into(),
            description: "New feature".into(),
        },
        CommitTypeOption {
            id: "fix".into(),
            label: "fix".into(),
            description: "Bug fix".into(),
        },
        CommitTypeOption {
            id: "docs".into(),
            label: "docs".into(),
            description: "Documentation".into(),
        },
        CommitTypeOption {
            id: "refactor".into(),
            label: "refactor".into(),
            description: "Code change without behavior change".into(),
        },
        CommitTypeOption {
            id: "perf".into(),
            label: "perf".into(),
            description: "Performance improvement".into(),
        },
        CommitTypeOption {
            id: "test".into(),
            label: "test".into(),
            description: "Tests".into(),
        },
        CommitTypeOption {
            id: "build".into(),
            label: "build".into(),
            description: "Build system or dependencies".into(),
        },
        CommitTypeOption {
            id: "ci".into(),
            label: "ci".into(),
            description: "CI configuration".into(),
        },
        CommitTypeOption {
            id: "chore".into(),
            label: "chore".into(),
            description: "Maintenance".into(),
        },
        CommitTypeOption {
            id: "revert".into(),
            label: "revert".into(),
            description: "Revert a previous commit".into(),
        },
    ]
}

fn default_connections() -> Vec<ConnectionConfig> {
    vec![
        ConnectionConfig {
            id: "github".into(),
            provider: "github".into(),
            label: "GitHub".into(),
            enabled: false,
            base_url: "https://api.github.com".into(),
            username: String::new(),
            token: String::new(),
            organization: String::new(),
            project: String::new(),
            has_token: false,
        },
        ConnectionConfig {
            id: "gitlab".into(),
            provider: "gitlab".into(),
            label: "GitLab".into(),
            enabled: false,
            base_url: "https://gitlab.com".into(),
            username: String::new(),
            token: String::new(),
            organization: String::new(),
            project: String::new(),
            has_token: false,
        },
        ConnectionConfig {
            id: "azureDevOps".into(),
            provider: "azureDevOps".into(),
            label: "Azure DevOps".into(),
            enabled: false,
            base_url: "https://dev.azure.com".into(),
            username: String::new(),
            token: String::new(),
            organization: String::new(),
            project: String::new(),
            has_token: false,
        },
        ConnectionConfig {
            id: "jira".into(),
            provider: "jira".into(),
            label: "Jira".into(),
            enabled: false,
            base_url: "https://your-domain.atlassian.net".into(),
            username: String::new(),
            token: String::new(),
            organization: String::new(),
            project: String::new(),
            has_token: false,
        },
    ]
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            theme: "system".into(),
            accent: "#3ECFFF".into(),
            simple_mode: true,
            layout: serde_json::json!({}),
            focus_mode: true,
            default_pull_action: default_pull_action(),
            default_push_action: default_push_action(),
            auto_fetch_on_open: false,
            confirm_force_push: true,
            confirm_discard: true,
            confirm_push_new_branch: true,
            confirm_add_tracking_ref: true,
            confirm_amend: true,
            confirm_undo_last_commit: true,
            confirm_stash_drop: true,
            confirm_abort_operation: true,
            confirm_abort_second: true,
            confirm_remove_remote: true,
            sign_off_by_default: false,
            push_after_commit: true,
            my_branches_only: false,
            branch_prefix_enabled: true,
            branch_prefix: default_branch_prefix(),
            branch_prefixes: default_branch_prefixes(),
            preferred_editor: default_preferred_editor(),
            editor_command: String::new(),
            diff_tool: String::new(),
            merge_tool: String::new(),
            ssh_client: default_ssh_client(),
            connections: default_connections(),
            commit_types: default_commit_types(),
            github_oauth_client_id: String::new(),
            notifications_enabled: true,
            notify_toasts: true,
            notify_desktop: true,
            notify_git_fetch: false,
            notify_git_pull: true,
            notify_git_push: true,
            notify_git_commit: true,
            notify_git_conflicts: true,
            notify_remote_behind: true,
            notify_app_updates: true,
            notify_pr_activity: true,
            notify_pr_ci: true,
        }
    }
}

fn ensure_defaults(mut settings: AppSettings) -> AppSettings {
    if settings.default_pull_action.is_empty() {
        settings.default_pull_action = default_pull_action();
    }
    if settings.default_push_action.is_empty() {
        settings.default_push_action = default_push_action();
    }
    if settings.ssh_client.is_empty() {
        settings.ssh_client = default_ssh_client();
    }
    if settings.branch_prefix.trim().is_empty() {
        settings.branch_prefix = default_branch_prefix();
    }
    if settings.branch_prefixes.is_empty() {
        settings.branch_prefixes = default_branch_prefixes();
    } else {
        settings.branch_prefixes = settings
            .branch_prefixes
            .into_iter()
            .map(|p| p.trim().trim_matches('/').to_string())
            .filter(|p| !p.is_empty())
            .collect::<Vec<_>>();
        if settings.branch_prefixes.is_empty() {
            settings.branch_prefixes = default_branch_prefixes();
        }
        if !settings
            .branch_prefixes
            .iter()
            .any(|p| p == &settings.branch_prefix)
        {
            settings
                .branch_prefixes
                .insert(0, settings.branch_prefix.clone());
        }
    }
    if settings.preferred_editor.trim().is_empty() {
        settings.preferred_editor = default_preferred_editor();
    }
    if settings.commit_types.is_empty() {
        settings.commit_types = default_commit_types();
    }
    if settings.connections.is_empty() {
        settings.connections = default_connections();
    } else {
        for def in default_connections() {
            if !settings
                .connections
                .iter()
                .any(|c| c.provider == def.provider)
            {
                settings.connections.push(def);
            }
        }
    }
    settings
}

fn redact_tokens(mut settings: AppSettings) -> AppSettings {
    for connection in &mut settings.connections {
        connection.has_token = !connection.token.trim().is_empty();
        connection.token.clear();
    }
    settings
}

fn merge_preserved_tokens(mut incoming: AppSettings, stored: &AppSettings) -> AppSettings {
    for connection in &mut incoming.connections {
        let token = connection.token.trim();
        if token.is_empty() {
            if let Some(existing) = stored
                .connections
                .iter()
                .find(|c| c.id == connection.id || c.provider == connection.provider)
            {
                if !existing.token.trim().is_empty() {
                    connection.token = existing.token.clone();
                }
            }
        }
    }
    incoming
}

#[command]
pub fn get_settings(state: State<'_, AppState>) -> AppResult<AppSettings> {
    Ok(redact_tokens(load_settings_with_tokens(&state)?))
}

pub fn load_settings_with_tokens(state: &AppState) -> AppResult<AppSettings> {
    let db = state.db.lock().map_err(|e| AppError::msg(e.to_string()))?;
    match sqlite::get_setting(&db, "app_settings")? {
        Some(raw) => {
            let parsed: AppSettings = serde_json::from_str(&raw).unwrap_or_default();
            Ok(ensure_defaults(parsed))
        }
        None => Ok(AppSettings::default()),
    }
}

#[command]
pub fn save_settings(state: State<'_, AppState>, input: AppSettings) -> AppResult<AppSettings> {
    let db = state.db.lock().map_err(|e| AppError::msg(e.to_string()))?;
    let stored = match sqlite::get_setting(&db, "app_settings")? {
        Some(raw) => serde_json::from_str::<AppSettings>(&raw).unwrap_or_default(),
        None => AppSettings::default(),
    };
    let settings = ensure_defaults(merge_preserved_tokens(input, &stored));
    let raw = serde_json::to_string(&settings)?;
    sqlite::set_setting(&db, "app_settings", &raw)?;
    if let Some(obj) = settings.layout.as_object() {
        if !obj.is_empty() {
            sqlite::set_setting(
                &db,
                "layout_json",
                &serde_json::to_string(&settings.layout)?,
            )?;
        }
    }
    Ok(redact_tokens(settings))
}
