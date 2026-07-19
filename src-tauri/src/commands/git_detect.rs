use crate::infrastructure::git_cli;
use crate::AppResult;
use serde::{Deserialize, Serialize};
use tauri::command;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectGitOutput {
    pub installed: bool,
    pub path: Option<String>,
    pub version: Option<String>,
    pub message: String,
}

#[command]
pub fn detect_git() -> AppResult<DetectGitOutput> {
    match which::which("git") {
        Ok(path) => match git_cli::version() {
            Ok(version) => Ok(DetectGitOutput {
                installed: true,
                path: Some(path.to_string_lossy().to_string()),
                version: Some(version.clone()),
                message: format!("Git found: {version}"),
            }),
            Err(e) => Ok(DetectGitOutput {
                installed: false,
                path: Some(path.to_string_lossy().to_string()),
                version: None,
                message: e.to_string(),
            }),
        },
        Err(_) => Ok(DetectGitOutput {
            installed: false,
            path: None,
            version: None,
            message: "Git is not installed or not on PATH".into(),
        }),
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectEditorsOutput {
    pub cursor: bool,
    pub vscode: bool,
    pub cursor_path: Option<String>,
    pub vscode_path: Option<String>,
}

#[command]
pub fn detect_editors() -> AppResult<DetectEditorsOutput> {
    let cursor_path = which::which("cursor")
        .ok()
        .map(|p| p.to_string_lossy().to_string());
    let vscode_path = which::which("code")
        .ok()
        .map(|p| p.to_string_lossy().to_string());
    Ok(DetectEditorsOutput {
        cursor: cursor_path.is_some(),
        vscode: vscode_path.is_some(),
        cursor_path,
        vscode_path,
    })
}
