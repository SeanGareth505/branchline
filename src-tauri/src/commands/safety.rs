use crate::domain::safety::{self, SafetyAction, SafetyAnalysis};
use crate::domain::undo;
use crate::infrastructure::{git_cli, git2_repo, sqlite};
use crate::state::AppState;
use crate::{AppError, AppResult};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::command;
use tauri::State;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalyzeSafetyInput {
    pub path: String,
    pub action: SafetyAction,
    pub target: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecuteSafeActionInput {
    pub path: String,
    pub action: SafetyAction,
    pub target: Option<String>,
    pub use_recommended: Option<bool>,
    pub confirmation_phrase: Option<String>,
    pub allow_bare_force: Option<bool>,
    pub acknowledged: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecuteSafeActionOutput {
    pub ok: bool,
    pub message: String,
    pub undoable: bool,
    pub analysis: SafetyAnalysis,
}

fn resolve_lock(
    state: &AppState,
    repo_key: &str,
    action: &SafetyAction,
    target: &Option<String>,
    path: &std::path::Path,
) -> AppResult<(bool, Option<String>)> {
    let branch = match action {
        SafetyAction::DeleteBranch => target.clone().unwrap_or_default(),
        SafetyAction::ForcePush => {
            if let Some(name) = target.clone().filter(|s| !s.is_empty()) {
                name
            } else {
                git2_repo::current_branch(path).unwrap_or_default()
            }
        }
        _ => return Ok((false, None)),
    };
    if branch.is_empty() {
        return Ok((false, None));
    }
    let db = state.db.lock().map_err(|e| AppError::msg(e.to_string()))?;
    match sqlite::get_branch_lock(&db, repo_key, &branch)? {
        Some(lock) => Ok((true, lock.reason)),
        None => Ok((false, None)),
    }
}

fn phrase_matches(analysis: &SafetyAnalysis, phrase: Option<&str>) -> bool {
    let Some(typed) = phrase.map(str::trim).filter(|s| !s.is_empty()) else {
        return false;
    };
    if let Some(target) = analysis
        .target
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        if typed == target {
            return true;
        }
    }
    typed.eq_ignore_ascii_case(analysis.confirm_prompt.trim())
}

fn load_confirm_force_push(state: &AppState) -> bool {
    let Ok(db) = state.db.lock() else {
        return true;
    };
    match sqlite::get_setting(&db, "app_settings") {
        Ok(Some(raw)) => serde_json::from_str::<serde_json::Value>(&raw)
            .ok()
            .and_then(|v| v.get("confirmForcePush").and_then(|x| x.as_bool()))
            .unwrap_or(true),
        _ => true,
    }
}

#[command]
pub fn analyze_safety(
    state: State<'_, AppState>,
    input: AnalyzeSafetyInput,
) -> AppResult<SafetyAnalysis> {
    git_cli::with_repo_lock(&PathBuf::from(&input.path), |path| {
        let repo_key = path.to_string_lossy().to_string();
        let (locked, reason) = resolve_lock(&state, &repo_key, &input.action, &input.target, path)?;
        Ok(safety::analyze_with_lock(
            path,
            input.action.clone(),
            input.target.clone(),
            locked,
            reason,
        ))
    })
}

#[command]
pub fn execute_safe_action(
    state: State<'_, AppState>,
    input: ExecuteSafeActionInput,
) -> AppResult<ExecuteSafeActionOutput> {
    git_cli::with_repo_lock(&PathBuf::from(&input.path), |path| {
        let repo_key = path.to_string_lossy().to_string();
        let (locked, reason) = resolve_lock(&state, &repo_key, &input.action, &input.target, path)?;
        let analysis = safety::analyze_with_lock(
            path,
            input.action.clone(),
            input.target.clone(),
            locked,
            reason,
        );
        let use_recommended = input.use_recommended.unwrap_or(true);
        let allow_bare_force = input.allow_bare_force.unwrap_or(false) && !use_recommended;
        let phrase = input.confirmation_phrase.as_deref();

        if analysis.blocked {
            let allowed_keep = use_recommended && analysis.recommended_action == "keep";
            if !allowed_keep {
                return Ok(ExecuteSafeActionOutput {
                    ok: false,
                    message: if locked {
                        sqlite::lock_block_message(
                            analysis.target.as_deref().unwrap_or("branch"),
                            analysis
                                .checks
                                .iter()
                                .find(|c| c.id == "not_locked")
                                .map(|c| c.detail.as_str())
                                .filter(|d| d.starts_with("Locked: "))
                                .map(|d| d.trim_start_matches("Locked: ")),
                        )
                    } else {
                        "Action is blocked by safety checks".into()
                    },
                    undoable: false,
                    analysis,
                });
            }
            return Ok(ExecuteSafeActionOutput {
                ok: true,
                message: "Kept — nothing changed".into(),
                undoable: false,
                analysis,
            });
        }

        let needs_typed = analysis.require_typed_confirm || allow_bare_force;

        if needs_typed && !phrase_matches(&analysis, phrase) {
            return Ok(ExecuteSafeActionOutput {
                ok: false,
                message: "Typed confirmation required".into(),
                undoable: false,
                analysis,
            });
        }

        let is_keep = use_recommended && analysis.recommended_action == "keep";
        let confirm_force = load_confirm_force_push(&state);
        let needs_ack = match analysis.action {
            SafetyAction::ForcePush => confirm_force || allow_bare_force,
            SafetyAction::HardReset
            | SafetyAction::Discard
            | SafetyAction::DeleteBranch
            | SafetyAction::DeleteTag => true,
        };
        if !is_keep && needs_ack && !input.acknowledged.unwrap_or(false) {
            return Ok(ExecuteSafeActionOutput {
                ok: false,
                message: "Action must be acknowledged".into(),
                undoable: false,
                analysis,
            });
        }

        if matches!(analysis.action, SafetyAction::ForcePush) && !use_recommended && !allow_bare_force
        {
            return Ok(ExecuteSafeActionOutput {
                ok: false,
                message: "Bare --force requires explicit allowBareForce confirmation".into(),
                undoable: false,
                analysis,
            });
        }

        if matches!(analysis.action, SafetyAction::Discard) {
            if let Some(target) = analysis.target.as_ref() {
                let specs: Vec<String> = target
                    .split('\n')
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(str::to_string)
                    .collect();
                git_cli::validate_pathspecs(&specs)?;
            }
        }

        let outcome = safety::execute(path, &analysis, use_recommended, allow_bare_force)?;

        if matches!(analysis.action, SafetyAction::DeleteBranch) {
            if let Some(branch) = analysis.target.as_deref() {
                let db = state.db.lock().map_err(|e| AppError::msg(e.to_string()))?;
                let _ = sqlite::unlock_branch(&db, &repo_key, branch);
            }
        }

        if outcome.undoable {
            if let (Some(action), Some(label), Some(payload)) = (
                outcome.undo_action.as_deref(),
                outcome.undo_label.as_deref(),
                outcome.undo_payload.clone(),
            ) {
                let db = state.db.lock().map_err(|e| AppError::msg(e.to_string()))?;
                let _ = undo::push_entry(&db, &repo_key, action, label, payload);
            }
        }

        Ok(ExecuteSafeActionOutput {
            ok: true,
            message: if outcome.message.is_empty() {
                "Completed".into()
            } else {
                outcome.message
            },
            undoable: outcome.undoable,
            analysis,
        })
    })
}
