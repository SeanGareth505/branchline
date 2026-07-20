use crate::{AppError, AppResult};
use serde::{Deserialize, Serialize};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

const MAX_ERROR_ENTRIES: usize = 50;
const ERROR_FILE: &str = "recent-errors.jsonl";
const CRASH_FILE: &str = "last-crash.json";
const SESSION_FILE: &str = "session.json";
const EXPECTED_RESTART_FILE: &str = "expected-restart.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CrashReport {
    pub at: String,
    pub message: String,
    pub location: Option<String>,
    pub version: String,
    pub os: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientErrorEntry {
    pub at: String,
    pub source: String,
    pub message: String,
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticsSummary {
    pub version: String,
    pub os: String,
    pub diagnostics_dir: String,
    pub log_hint: String,
    pub last_crash: Option<CrashReport>,
    pub recent_errors: Vec<ClientErrorEntry>,
    pub last_unclean_shutdown: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionState {
    started_at: String,
    clean_exit: bool,
    version: String,
}

fn now_rfc3339() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    chrono::DateTime::from_timestamp(secs, 0)
        .map(|dt| dt.to_rfc3339())
        .unwrap_or_else(|| secs.to_string())
}

pub fn diagnostics_dir() -> AppResult<PathBuf> {
    let dir = super::sqlite::app_data_dir()?.join("diagnostics");
    fs::create_dir_all(&dir).map_err(|e| AppError::msg(e.to_string()))?;
    Ok(dir)
}

pub fn logs_hint() -> String {
    #[cfg(target_os = "macos")]
    {
        return "~/Library/Logs/app.branchline.git".into();
    }
    #[cfg(target_os = "windows")]
    {
        return "%APPDATA%\\branchline\\logs".into();
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        "~/.local/share/branchline/logs".into()
    }
}

pub fn mark_session_start() {
    let Ok(dir) = diagnostics_dir() else {
        return;
    };
    let session_path = dir.join(SESSION_FILE);
    let expected_restart = dir.join(EXPECTED_RESTART_FILE).exists();
    if expected_restart {
        let _ = fs::remove_file(dir.join(EXPECTED_RESTART_FILE));
    }
    if let Ok(raw) = fs::read_to_string(&session_path) {
        if let Ok(prev) = serde_json::from_str::<SessionState>(&raw) {
            if !prev.clean_exit {
                if expected_restart || cfg!(debug_assertions) {
                    let _ = record_client_error(
                        "dev-restart",
                        &format!(
                            "Previous debug session ended abruptly (started {})",
                            prev.started_at
                        ),
                        Some(if expected_restart {
                            "Expected restart after Cargo.toml/lock version bump during release"
                        } else {
                            "Usually tauri:dev rebuilding after Cargo.toml/source changes — not a crash"
                        }),
                    );
                } else {
                    let _ = record_client_error(
                        "unclean-shutdown",
                        &format!(
                            "Previous session did not exit cleanly (started {})",
                            prev.started_at
                        ),
                        Some("App may have crashed, been force-quit, or been killed by the OS"),
                    );
                    let report = CrashReport {
                        at: now_rfc3339(),
                        message: format!(
                            "Unclean shutdown detected from session started {}",
                            prev.started_at
                        ),
                        location: None,
                        version: env!("CARGO_PKG_VERSION").into(),
                        os: std::env::consts::OS.into(),
                    };
                    if let Ok(json) = serde_json::to_string_pretty(&report) {
                        let _ = fs::write(dir.join(CRASH_FILE), json);
                    }
                }
            }
        }
    }
    let next = SessionState {
        started_at: now_rfc3339(),
        clean_exit: false,
        version: env!("CARGO_PKG_VERSION").into(),
    };
    if let Ok(json) = serde_json::to_string_pretty(&next) {
        let _ = fs::write(session_path, json);
    }
}

pub fn mark_session_clean_exit() {
    let Ok(dir) = diagnostics_dir() else {
        return;
    };
    let session_path = dir.join(SESSION_FILE);
    let next = SessionState {
        started_at: now_rfc3339(),
        clean_exit: true,
        version: env!("CARGO_PKG_VERSION").into(),
    };
    if let Ok(json) = serde_json::to_string_pretty(&next) {
        let _ = fs::write(session_path, json);
    }
}

pub fn mark_expected_restart(reason: &str) {
    let Ok(dir) = diagnostics_dir() else {
        return;
    };
    let payload = serde_json::json!({
        "at": now_rfc3339(),
        "reason": reason,
    });
    if let Ok(json) = serde_json::to_string_pretty(&payload) {
        let _ = fs::write(dir.join(EXPECTED_RESTART_FILE), json);
    }
}

pub fn last_unclean_shutdown_message() -> Option<String> {
    recent_errors()
        .into_iter()
        .rev()
        .find(|e| e.source == "unclean-shutdown")
        .map(|e| e.message)
}

pub fn install_panic_hook() {
    static INSTALLED: Mutex<bool> = Mutex::new(false);
    if let Ok(mut installed) = INSTALLED.lock() {
        if *installed {
            return;
        }
        *installed = true;
    }

    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let message = if let Some(s) = info.payload().downcast_ref::<&str>() {
            (*s).to_string()
        } else if let Some(s) = info.payload().downcast_ref::<String>() {
            s.clone()
        } else {
            "unknown panic".into()
        };
        let location = info.location().map(|loc| {
            format!("{}:{}:{}", loc.file(), loc.line(), loc.column())
        });
        let report = CrashReport {
            at: now_rfc3339(),
            message: message.clone(),
            location: location.clone(),
            version: env!("CARGO_PKG_VERSION").into(),
            os: std::env::consts::OS.into(),
        };
        if let Ok(dir) = diagnostics_dir() {
            let path = dir.join(CRASH_FILE);
            if let Ok(json) = serde_json::to_string_pretty(&report) {
                let _ = fs::write(path, json);
            }
            let _ = append_error_line(
                &dir,
                &ClientErrorEntry {
                    at: report.at.clone(),
                    source: "panic".into(),
                    message,
                    detail: location,
                },
            );
        }
        log::error!(
            "panic: {} ({})",
            report.message,
            report.location.as_deref().unwrap_or("unknown location")
        );
        previous(info);
    }));
}

pub fn read_last_crash() -> Option<CrashReport> {
    let path = diagnostics_dir().ok()?.join(CRASH_FILE);
    let raw = fs::read_to_string(path).ok()?;
    serde_json::from_str(&raw).ok()
}

pub fn record_client_error(source: &str, message: &str, detail: Option<&str>) -> AppResult<()> {
    let dir = diagnostics_dir()?;
    let entry = ClientErrorEntry {
        at: now_rfc3339(),
        source: source.trim().to_string(),
        message: message.trim().to_string(),
        detail: detail.map(|s| s.trim().to_string()).filter(|s| !s.is_empty()),
    };
    log::warn!("[{}] {}", entry.source, entry.message);
    append_error_line(&dir, &entry)?;
    Ok(())
}

fn append_error_line(dir: &Path, entry: &ClientErrorEntry) -> AppResult<()> {
    let path = dir.join(ERROR_FILE);
    let line = serde_json::to_string(entry).map_err(|e| AppError::msg(e.to_string()))?;
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| AppError::msg(e.to_string()))?;
    writeln!(file, "{line}").map_err(|e| AppError::msg(e.to_string()))?;
    trim_error_file(&path)?;
    Ok(())
}

fn trim_error_file(path: &Path) -> AppResult<()> {
    let Ok(raw) = fs::read_to_string(path) else {
        return Ok(());
    };
    let lines: Vec<&str> = raw.lines().filter(|l| !l.trim().is_empty()).collect();
    if lines.len() <= MAX_ERROR_ENTRIES {
        return Ok(());
    }
    let keep = &lines[lines.len() - MAX_ERROR_ENTRIES..];
    fs::write(path, keep.join("\n") + "\n").map_err(|e| AppError::msg(e.to_string()))?;
    Ok(())
}

pub fn recent_errors() -> Vec<ClientErrorEntry> {
    let Ok(dir) = diagnostics_dir() else {
        return vec![];
    };
    let Ok(raw) = fs::read_to_string(dir.join(ERROR_FILE)) else {
        return vec![];
    };
    raw.lines()
        .rev()
        .filter_map(|line| serde_json::from_str::<ClientErrorEntry>(line).ok())
        .take(20)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect()
}

pub fn summary() -> AppResult<DiagnosticsSummary> {
    let dir = diagnostics_dir()?;
    Ok(DiagnosticsSummary {
        version: env!("CARGO_PKG_VERSION").into(),
        os: std::env::consts::OS.into(),
        diagnostics_dir: dir.to_string_lossy().to_string(),
        log_hint: logs_hint(),
        last_crash: read_last_crash(),
        recent_errors: recent_errors(),
        last_unclean_shutdown: last_unclean_shutdown_message(),
    })
}

pub fn clear_diagnostics() -> AppResult<()> {
    let dir = diagnostics_dir()?;
    let _ = fs::remove_file(dir.join(CRASH_FILE));
    let _ = fs::remove_file(dir.join(ERROR_FILE));
    let _ = fs::remove_file(dir.join(SESSION_FILE));
    let _ = fs::remove_file(dir.join(EXPECTED_RESTART_FILE));
    Ok(())
}

pub fn copy_diagnostics_text() -> AppResult<String> {
    let summary = summary()?;
    let mut out = String::new();
    out.push_str(&format!(
        "Branchline diagnostics\nversion: {}\nos: {}\ndiagnostics: {}\nlogs: {}\n\n",
        summary.version, summary.os, summary.diagnostics_dir, summary.log_hint
    ));
    if let Some(crash) = &summary.last_crash {
        out.push_str(&format!(
            "Last crash ({})\n{}\n{}\n\n",
            crash.at,
            crash.message,
            crash.location.as_deref().unwrap_or("")
        ));
    } else {
        out.push_str("Last crash: none\n\n");
    }
    out.push_str("Recent errors:\n");
    if summary.recent_errors.is_empty() {
        out.push_str("(none)\n");
    } else {
        for err in &summary.recent_errors {
            out.push_str(&format!(
                "- [{}] {} · {}\n",
                err.source,
                err.at,
                err.message
            ));
            if let Some(detail) = &err.detail {
                out.push_str(&format!("  {detail}\n"));
            }
        }
    }
    Ok(out)
}
