use crate::infrastructure::diagnostics;
use crate::AppResult;
use serde::Deserialize;
use tauri::command;
use tauri_plugin_opener::OpenerExt;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordErrorInput {
    pub source: String,
    pub message: String,
    pub detail: Option<String>,
}

#[command]
pub fn get_diagnostics_summary() -> AppResult<diagnostics::DiagnosticsSummary> {
    diagnostics::summary()
}

#[command]
pub fn record_client_error(input: RecordErrorInput) -> AppResult<()> {
    diagnostics::record_client_error(
        &input.source,
        &input.message,
        input.detail.as_deref(),
    )
}

#[command]
pub fn get_diagnostics_text() -> AppResult<String> {
    diagnostics::copy_diagnostics_text()
}

#[command]
pub fn clear_diagnostics() -> AppResult<()> {
    diagnostics::clear_diagnostics()
}

#[command]
pub fn open_diagnostics_folder(app: tauri::AppHandle) -> AppResult<()> {
    let dir = diagnostics::diagnostics_dir()?;
    app.opener()
        .open_path(dir.to_string_lossy().to_string(), None::<String>)
        .map_err(|e| crate::AppError::msg(e.to_string()))?;
    Ok(())
}
