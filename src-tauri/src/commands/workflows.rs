use crate::infrastructure::{mock_providers, sqlite};
use crate::state::AppState;
use crate::{AppError, AppResult};
use mock_providers::{WorkflowInfo, WorkflowStep};
use serde::Deserialize;
use tauri::{command, State};

const SETTINGS_KEY: &str = "workflows_json";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveWorkflowInput {
    pub id: Option<String>,
    pub name: String,
    pub description: String,
    pub steps: Vec<WorkflowStep>,
    pub enabled: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowIdInput {
    pub id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetWorkflowEnabledInput {
    pub id: String,
    pub enabled: bool,
}

#[derive(Debug, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredWorkflows {
    custom: Vec<WorkflowInfo>,
    disabled_builtins: Vec<String>,
}

fn load_stored(db: &rusqlite::Connection) -> AppResult<StoredWorkflows> {
    match sqlite::get_setting(db, SETTINGS_KEY)? {
        Some(raw) => Ok(serde_json::from_str(&raw).unwrap_or_default()),
        None => Ok(StoredWorkflows::default()),
    }
}

fn save_stored(db: &rusqlite::Connection, stored: &StoredWorkflows) -> AppResult<()> {
    let raw = serde_json::to_string(stored).map_err(|e| AppError::msg(e.to_string()))?;
    sqlite::set_setting(db, SETTINGS_KEY, &raw)
}

fn merge_workflows(stored: &StoredWorkflows) -> Vec<WorkflowInfo> {
    let mut builtins = mock_providers::builtin_workflows();
    for wf in &mut builtins {
        if stored.disabled_builtins.iter().any(|id| id == &wf.id) {
            wf.enabled = false;
        }
    }
    let mut all = builtins;
    all.extend(stored.custom.clone());
    all
}

#[command]
pub fn list_workflows(state: State<'_, AppState>) -> AppResult<Vec<WorkflowInfo>> {
    let db = state
        .db
        .lock()
        .map_err(|_| AppError::msg("Database lock poisoned"))?;
    let stored = load_stored(&db)?;
    Ok(merge_workflows(&stored))
}

#[command]
pub fn save_workflow(
    state: State<'_, AppState>,
    input: SaveWorkflowInput,
) -> AppResult<WorkflowInfo> {
    let name = input.name.trim().to_string();
    if name.is_empty() {
        return Err(AppError::msg("Workflow name is required"));
    }
    if input.steps.is_empty() {
        return Err(AppError::msg("Add at least one step"));
    }

    let db = state
        .db
        .lock()
        .map_err(|_| AppError::msg("Database lock poisoned"))?;
    let mut stored = load_stored(&db)?;

    let workflow = if let Some(id) = input.id.as_ref().filter(|s| !s.trim().is_empty()) {
        if mock_providers::builtin_workflows()
            .iter()
            .any(|b| &b.id == id)
        {
            return Err(AppError::msg(
                "Built-in workflows cannot be edited — duplicate them instead",
            ));
        }
        let Some(existing) = stored.custom.iter_mut().find(|w| &w.id == id) else {
            return Err(AppError::msg("Workflow not found"));
        };
        existing.name = name;
        existing.description = input.description.trim().to_string();
        existing.steps = input.steps;
        if let Some(enabled) = input.enabled {
            existing.enabled = enabled;
        }
        existing.clone()
    } else {
        let workflow = WorkflowInfo {
            id: format!("wf-{}", uuid_like()),
            name,
            description: input.description.trim().to_string(),
            steps: input.steps,
            builtin: false,
            enabled: input.enabled.unwrap_or(true),
        };
        stored.custom.push(workflow.clone());
        workflow
    };

    save_stored(&db, &stored)?;
    Ok(workflow)
}

#[command]
pub fn delete_workflow(
    state: State<'_, AppState>,
    input: WorkflowIdInput,
) -> AppResult<Vec<WorkflowInfo>> {
    let db = state
        .db
        .lock()
        .map_err(|_| AppError::msg("Database lock poisoned"))?;
    let mut stored = load_stored(&db)?;

    if mock_providers::builtin_workflows()
        .iter()
        .any(|b| b.id == input.id)
    {
        return Err(AppError::msg(
            "Built-in workflows cannot be deleted — disable or duplicate them",
        ));
    }

    let before = stored.custom.len();
    stored.custom.retain(|w| w.id != input.id);
    if stored.custom.len() == before {
        return Err(AppError::msg("Workflow not found"));
    }

    save_stored(&db, &stored)?;
    Ok(merge_workflows(&stored))
}

#[command]
pub fn set_workflow_enabled(
    state: State<'_, AppState>,
    input: SetWorkflowEnabledInput,
) -> AppResult<Vec<WorkflowInfo>> {
    let db = state
        .db
        .lock()
        .map_err(|_| AppError::msg("Database lock poisoned"))?;
    let mut stored = load_stored(&db)?;

    if mock_providers::builtin_workflows()
        .iter()
        .any(|b| b.id == input.id)
    {
        if input.enabled {
            stored.disabled_builtins.retain(|id| id != &input.id);
        } else if !stored.disabled_builtins.iter().any(|id| id == &input.id) {
            stored.disabled_builtins.push(input.id.clone());
        }
    } else {
        let Some(existing) = stored.custom.iter_mut().find(|w| w.id == input.id) else {
            return Err(AppError::msg("Workflow not found"));
        };
        existing.enabled = input.enabled;
    }

    save_stored(&db, &stored)?;
    Ok(merge_workflows(&stored))
}

fn uuid_like() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{nanos:x}")
}
