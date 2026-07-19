use crate::commands::git_detect::detect_git;
use crate::commands::identity::get_git_identity;
use crate::infrastructure::{git_cli, sqlite};
use crate::state::AppState;
use crate::AppResult;
use serde::{Deserialize, Serialize};
use tauri::command;
use tauri::State;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ChecklistStatus {
    Verified,
    NeedsAttention,
    Skipped,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OnboardingChecklistItem {
    pub id: String,
    pub label: String,
    pub description: String,
    pub status: ChecklistStatus,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OnboardingStatusOutput {
    pub completed: bool,
    pub skipped: bool,
    pub items: Vec<OnboardingChecklistItem>,
}

fn ssh_keys_found() -> bool {
    if let Some(home) = dirs::home_dir() {
        let ssh = home.join(".ssh");
        for name in [
            "id_ed25519",
            "id_rsa",
            "id_ecdsa",
            "id_ed25519.pub",
            "id_rsa.pub",
        ] {
            if ssh.join(name).exists() {
                return true;
            }
        }
    }
    false
}

fn credential_helper_set() -> bool {
    git_cli::config_get("credential.helper")
        .ok()
        .flatten()
        .map(|v| !v.is_empty())
        .unwrap_or(false)
}

fn default_tools_ok() -> bool {
    which::which("git").is_ok()
}

fn build_items() -> Vec<OnboardingChecklistItem> {
    let git = detect_git().ok();
    let identity = get_git_identity(None).ok();

    let git_status = if git.as_ref().map(|g| g.installed).unwrap_or(false) {
        ChecklistStatus::Verified
    } else {
        ChecklistStatus::NeedsAttention
    };

    let identity_ok = identity
        .as_ref()
        .map(|i| !i.name.is_empty() && !i.email.is_empty())
        .unwrap_or(false);

    vec![
        OnboardingChecklistItem {
            id: "git".into(),
            label: "Git installed".into(),
            description: git
                .map(|g| g.message)
                .unwrap_or_else(|| "Unable to detect Git".into()),
            status: git_status,
        },
        OnboardingChecklistItem {
            id: "identity".into(),
            label: "Git identity".into(),
            description: if identity_ok {
                "user.name and user.email are set".into()
            } else {
                "Set your name and email for commits".into()
            },
            status: if identity_ok {
                ChecklistStatus::Verified
            } else {
                ChecklistStatus::NeedsAttention
            },
        },
        OnboardingChecklistItem {
            id: "ssh".into(),
            label: "SSH for Git remotes".into(),
            description: if ssh_keys_found() {
                "Key found — use it to push/pull to GitHub and other hosts".into()
            } else {
                "Needed to push and pull over SSH (optional if you use HTTPS)".into()
            },
            status: if ssh_keys_found() {
                ChecklistStatus::Verified
            } else {
                ChecklistStatus::NeedsAttention
            },
        },
        OnboardingChecklistItem {
            id: "credentialHelper".into(),
            label: "Credential helper".into(),
            description: if credential_helper_set() {
                "credential.helper is configured".into()
            } else {
                "No credential helper configured (optional)".into()
            },
            status: if credential_helper_set() {
                ChecklistStatus::Verified
            } else {
                ChecklistStatus::NeedsAttention
            },
        },
        OnboardingChecklistItem {
            id: "defaultTools".into(),
            label: "Default tools".into(),
            description: if default_tools_ok() {
                "Required CLI tools available".into()
            } else {
                "Git CLI missing from PATH".into()
            },
            status: if default_tools_ok() {
                ChecklistStatus::Verified
            } else {
                ChecklistStatus::NeedsAttention
            },
        },
    ]
}

#[command]
pub fn get_onboarding_status(state: State<'_, AppState>) -> AppResult<OnboardingStatusOutput> {
    let db = state
        .db
        .lock()
        .map_err(|e| crate::AppError::msg(e.to_string()))?;
    let stored = sqlite::get_onboarding(&db)?;
    let items = build_items();
    let _ = sqlite::set_onboarding_checklist(&db, &serde_json::to_string(&items)?);
    Ok(OnboardingStatusOutput {
        completed: stored.completed,
        skipped: stored.skipped,
        items,
    })
}

#[command]
pub fn complete_onboarding(state: State<'_, AppState>) -> AppResult<OnboardingStatusOutput> {
    {
        let db = state
            .db
            .lock()
            .map_err(|e| crate::AppError::msg(e.to_string()))?;
        sqlite::set_onboarding_complete(&db, true, false)?;
    }
    get_onboarding_status(state)
}

#[command]
pub fn skip_onboarding(state: State<'_, AppState>) -> AppResult<OnboardingStatusOutput> {
    {
        let db = state
            .db
            .lock()
            .map_err(|e| crate::AppError::msg(e.to_string()))?;
        sqlite::set_onboarding_complete(&db, true, true)?;
    }
    let mut status = get_onboarding_status(state)?;
    for item in &mut status.items {
        if matches!(item.status, ChecklistStatus::NeedsAttention) {
            item.status = ChecklistStatus::Skipped;
        }
    }
    status.skipped = true;
    status.completed = true;
    Ok(status)
}
