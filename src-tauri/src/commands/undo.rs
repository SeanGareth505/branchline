use crate::domain::undo::{self, UndoEntry};
use crate::state::AppState;
use crate::{AppError, AppResult};
use serde::{Deserialize, Serialize};
use tauri::command;
use tauri::State;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UndoLastInput {
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListUndoInput {
    pub path: Option<String>,
    pub limit: Option<i64>,
}

#[command]
pub fn undo_last(state: State<'_, AppState>, input: UndoLastInput) -> AppResult<Option<UndoEntry>> {
    let db = state.db.lock().map_err(|e| AppError::msg(e.to_string()))?;
    undo::undo_last(&db, &input.path)
}

#[command]
pub fn list_undo_journal(
    state: State<'_, AppState>,
    input: ListUndoInput,
) -> AppResult<Vec<UndoEntry>> {
    let db = state.db.lock().map_err(|e| AppError::msg(e.to_string()))?;
    let limit = input.limit.unwrap_or(50).clamp(1, 500);
    undo::list_entries(&db, input.path.as_deref(), limit)
}
