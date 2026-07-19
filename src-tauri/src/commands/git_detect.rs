use crate::AppResult;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::command;

use crate::infrastructure::git_cli;

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

fn first_existing(paths: &[PathBuf]) -> Option<String> {
    paths.iter().find(|p| p.exists()).map(|p| p.to_string_lossy().to_string())
}

fn home() -> PathBuf {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_default()
}

fn detect_cursor_path() -> Option<String> {
    if let Ok(p) = which::which("cursor") {
        return Some(p.to_string_lossy().to_string());
    }
    let h = home();
    first_existing(&[
        PathBuf::from("/Applications/Cursor.app/Contents/Resources/app/bin/cursor"),
        h.join("Applications/Cursor.app/Contents/Resources/app/bin/cursor"),
        PathBuf::from("/usr/local/bin/cursor"),
        PathBuf::from("/opt/homebrew/bin/cursor"),
        h.join("AppData/Local/Programs/cursor/resources/app/bin/cursor.cmd"),
        h.join("AppData/Local/Programs/Cursor/resources/app/bin/cursor.cmd"),
    ])
}

fn detect_vscode_path() -> Option<String> {
    if let Ok(p) = which::which("code") {
        return Some(p.to_string_lossy().to_string());
    }
    let h = home();
    first_existing(&[
        PathBuf::from(
            "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code",
        ),
        h.join("Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"),
        PathBuf::from("/usr/local/bin/code"),
        PathBuf::from("/opt/homebrew/bin/code"),
        h.join("AppData/Local/Programs/Microsoft VS Code/bin/code.cmd"),
    ])
}

#[command]
pub fn detect_editors() -> AppResult<DetectEditorsOutput> {
    let cursor_path = detect_cursor_path();
    let vscode_path = detect_vscode_path();
    Ok(DetectEditorsOutput {
        cursor: cursor_path.is_some(),
        vscode: vscode_path.is_some(),
        cursor_path,
        vscode_path,
    })
}
