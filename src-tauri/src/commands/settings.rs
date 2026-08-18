use crate::infrastructure::{diagnostics, secrets, sqlite};
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
    pub fetch_all_remotes: bool,
    #[serde(default = "default_true")]
    pub fetch_prune: bool,
    #[serde(default)]
    pub fetch_tags: bool,
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
    pub keep_git_process_open: bool,
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
    #[serde(default = "default_ticket_from_branch")]
    pub ticket_from_branch: TicketFromBranchSettings,
    #[serde(default)]
    pub commit_shortcut_sequence: Vec<String>,
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
    #[serde(default = "default_true")]
    pub notify_release: bool,
    #[serde(default)]
    pub hide_untracked: bool,
    #[serde(default = "default_density")]
    pub ui_density: String,
    #[serde(default)]
    pub pr_templates: Vec<SavedPrTemplate>,
    #[serde(default = "default_pr_create_method")]
    pub pr_create_method: String,
    #[serde(default)]
    pub github_repo_accounts: std::collections::HashMap<String, GithubRepoAccountPref>,
    #[serde(default)]
    pub selected_repo_account: String,
    #[serde(default = "default_git_flow_main")]
    pub git_flow_main: String,
    #[serde(default = "default_git_flow_develop")]
    pub git_flow_develop: String,
    #[serde(default)]
    pub pinned_commits: std::collections::HashMap<String, Vec<String>>,
    #[serde(default)]
    pub keyboard_shortcuts: std::collections::HashMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubRepoAccountPref {
    pub login: String,
    pub protocol: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TicketFromBranchSettings {
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default = "default_true")]
    pub match_ticket_key: bool,
    #[serde(default)]
    pub use_segment: bool,
    #[serde(default = "default_segment_index")]
    pub segment_index: i32,
    #[serde(default)]
    pub custom_pattern: String,
    #[serde(default = "default_ticket_case")]
    pub ticket_case: String,
    #[serde(default = "default_true")]
    pub put_in_scope: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedPrTemplate {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub body: String,
}

fn default_density() -> String {
    "comfortable".into()
}

fn default_pr_create_method() -> String {
    "browser".into()
}

fn default_git_flow_main() -> String {
    "main".into()
}

fn default_git_flow_develop() -> String {
    "develop".into()
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

fn default_segment_index() -> i32 {
    -1
}

fn default_ticket_case() -> String {
    "preserve".into()
}

fn default_ticket_from_branch() -> TicketFromBranchSettings {
    TicketFromBranchSettings {
        enabled: true,
        match_ticket_key: true,
        use_segment: false,
        segment_index: -1,
        custom_pattern: String::new(),
        ticket_case: default_ticket_case(),
        put_in_scope: true,
    }
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
            id: "style".into(),
            label: "style".into(),
            description: "Formatting only".into(),
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
            base_url: String::new(),
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
            fetch_all_remotes: true,
            fetch_prune: true,
            fetch_tags: false,
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
            keep_git_process_open: false,
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
            ticket_from_branch: default_ticket_from_branch(),
            commit_shortcut_sequence: Vec::new(),
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
            notify_release: true,
            hide_untracked: false,
            ui_density: default_density(),
            pr_templates: Vec::new(),
            pr_create_method: default_pr_create_method(),
            github_repo_accounts: std::collections::HashMap::new(),
            selected_repo_account: String::new(),
            git_flow_main: default_git_flow_main(),
            git_flow_develop: default_git_flow_develop(),
            pinned_commits: std::collections::HashMap::new(),
            keyboard_shortcuts: std::collections::HashMap::new(),
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
    if settings.ui_density != "compact" && settings.ui_density != "comfortable" {
        settings.ui_density = default_density();
    }
    if settings.pr_create_method != "cli" && settings.pr_create_method != "browser" {
        settings.pr_create_method = default_pr_create_method();
    }
    if settings.git_flow_main.trim().is_empty() {
        settings.git_flow_main = default_git_flow_main();
    }
    if settings.git_flow_develop.trim().is_empty() {
        settings.git_flow_develop = default_git_flow_develop();
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
    if settings.ticket_from_branch.ticket_case != "preserve"
        && settings.ticket_from_branch.ticket_case != "upper"
        && settings.ticket_from_branch.ticket_case != "lower"
    {
        settings.ticket_from_branch.ticket_case = default_ticket_case();
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
            if !connection.has_token {
                connection.token.clear();
                continue;
            }
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

fn hydrate_connection_tokens(settings: &mut AppSettings) -> bool {
    let mut migrated = false;
    for connection in &mut settings.connections {
        let db_token = connection.token.trim().to_string();
        match secrets::get_connection_token(&connection.id) {
            Ok(Some(secret)) => {
                connection.token = secret;
                if !db_token.is_empty() {
                    migrated = true;
                }
            }
            Ok(None) | Err(_) => {
                if !db_token.is_empty() {
                    if secrets::set_connection_token(&connection.id, &db_token).is_ok() {
                        migrated = true;
                    }
                    connection.token = db_token;
                }
            }
        }
        connection.has_token = !connection.token.trim().is_empty();
    }
    migrated
}

fn persist_connection_secrets(settings: &AppSettings) -> AppSettings {
    let mut disk = settings.clone();
    for connection in &mut disk.connections {
        let token = connection.token.trim().to_string();
        connection.has_token = !token.is_empty();
        if token.is_empty() {
            let _ = secrets::delete_connection_token(&connection.id);
            connection.token.clear();
            continue;
        }
        if secrets::set_connection_token(&connection.id, &token).is_ok() {
            connection.token.clear();
        }
    }
    disk
}

fn parse_stored_settings(raw: &str) -> AppResult<AppSettings> {
    serde_json::from_str(raw).map_err(|err| {
        let _ = diagnostics::record_client_error(
            "settings.parse",
            "Saved settings could not be read",
            Some(&err.to_string()),
        );
        AppError::msg(format!(
            "Saved settings are unreadable and were not reset. Open Diagnostics to inspect them, then retry. ({err})"
        ))
    })
}

#[command]
pub fn get_settings(state: State<'_, AppState>) -> AppResult<AppSettings> {
    Ok(redact_tokens(load_settings_with_tokens(&state)?))
}

pub fn load_settings_with_tokens(state: &AppState) -> AppResult<AppSettings> {
    let db = state.db.lock().map_err(|e| AppError::msg(e.to_string()))?;
    let mut settings = match sqlite::get_setting(&db, "app_settings")? {
        Some(raw) => ensure_defaults(parse_stored_settings(&raw)?),
        None => AppSettings::default(),
    };
    let migrated = hydrate_connection_tokens(&mut settings);
    if migrated {
        let disk = persist_connection_secrets(&settings);
        sqlite::set_setting(&db, "app_settings", &serde_json::to_string(&disk)?)?;
    }
    Ok(settings)
}

#[command]
pub fn save_settings(state: State<'_, AppState>, input: AppSettings) -> AppResult<AppSettings> {
    let db = state.db.lock().map_err(|e| AppError::msg(e.to_string()))?;
    let mut stored = match sqlite::get_setting(&db, "app_settings")? {
        Some(raw) => parse_stored_settings(&raw)?,
        None => AppSettings::default(),
    };
    hydrate_connection_tokens(&mut stored);
    let settings = ensure_defaults(merge_preserved_tokens(input, &stored));
    let disk = persist_connection_secrets(&settings);
    let raw = serde_json::to_string(&disk)?;
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
