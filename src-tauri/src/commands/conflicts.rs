use crate::infrastructure::git_cli;
use crate::AppResult;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use tauri::command;

use super::branch::MutationOutput;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictFileInput {
    pub path: String,
    pub file_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictSidesOutput {
    pub path: String,
    pub base: String,
    pub ours: String,
    pub theirs: String,
    pub working: String,
    pub has_base: bool,
    pub has_ours: bool,
    pub has_theirs: bool,
    pub binary: bool,
    pub unmerged: bool,
    pub has_markers: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolveConflictInput {
    pub path: String,
    pub file_path: String,
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenConflictInIdeInput {
    pub path: String,
    pub file_path: String,
    /// "cursor" | "vscode" | "auto"
    pub editor: String,
    /// "file" opens markers in editor; "merge" opens 3-way merge UI
    #[serde(default)]
    pub mode: Option<String>,
    #[serde(default)]
    pub cursor_path: Option<String>,
    #[serde(default)]
    pub vscode_path: Option<String>,
    /// Wait for the editor process to exit (code/cursor --wait).
    #[serde(default)]
    pub wait: Option<bool>,
    /// After wait, stage the file when markers are gone and it is still unmerged.
    #[serde(default)]
    pub stage_if_resolved: Option<bool>,
}

fn normalize_repo_rel(path: &str) -> AppResult<String> {
    let trimmed = path.trim().replace('\\', "/");
    if trimmed.is_empty() {
        return Err(crate::AppError::msg("File path is required"));
    }
    let pb = PathBuf::from(&trimmed);
    if pb.is_absolute() {
        return Err(crate::AppError::msg("File path must be relative to the repository"));
    }
    for c in pb.components() {
        match c {
            Component::Normal(_) => {}
            Component::CurDir => {}
            _ => {
                return Err(crate::AppError::msg(
                    "File path must stay inside the repository",
                ));
            }
        }
    }
    Ok(trimmed.trim_start_matches("./").to_string())
}

fn stage_blob(repo: &Path, stage: u8, rel: &str) -> (bool, String) {
    let spec = format!(":{stage}:{rel}");
    let (ok, out, _) = git_cli::run_git_allow_fail(repo, &["show", &spec]);
    if ok {
        (true, out)
    } else {
        (false, String::new())
    }
}

fn looks_binary(s: &str) -> bool {
    s.bytes().take(8192).any(|b| b == 0)
}

fn working_has_markers(content: &str) -> bool {
    content.lines().any(|line| {
        line.starts_with("<<<<<<< ")
            || line == "<<<<<<<"
            || line.starts_with(">>>>>>> ")
            || line == ">>>>>>>"
    })
}

fn path_is_unmerged(repo: &Path, rel: &str) -> bool {
    let (ok, out, _) = git_cli::run_git_allow_fail(repo, &["ls-files", "-u", "--", rel]);
    ok && !out.trim().is_empty()
}

fn read_working(repo: &Path, rel: &str) -> String {
    let file = repo.join(rel);
    if file.exists() {
        fs::read_to_string(&file).unwrap_or_default()
    } else {
        String::new()
    }
}

fn resolve_ide_bin(
    editor: &str,
    cursor_path: Option<&str>,
    vscode_path: Option<&str>,
) -> AppResult<(String, &'static str)> {
    let pick = |name: &str, hint: Option<&str>, fallbacks: &[PathBuf]| -> Option<String> {
        if let Some(h) = hint.map(str::trim).filter(|s| !s.is_empty()) {
            let p = PathBuf::from(h);
            if p.exists() {
                return Some(h.to_string());
            }
        }
        if let Ok(p) = which::which(name) {
            return Some(p.to_string_lossy().to_string());
        }
        fallbacks
            .iter()
            .find(|p| p.exists())
            .map(|p| p.to_string_lossy().to_string())
    };

    let home = dirs_home();
    let cursor_fallbacks = [
        PathBuf::from("/Applications/Cursor.app/Contents/Resources/app/bin/cursor"),
        PathBuf::from(format!(
            "{home}/Applications/Cursor.app/Contents/Resources/app/bin/cursor"
        )),
        PathBuf::from("/usr/local/bin/cursor"),
        PathBuf::from("/opt/homebrew/bin/cursor"),
    ];
    let vscode_fallbacks = [
        PathBuf::from("/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"),
        PathBuf::from(format!(
            "{home}/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"
        )),
        PathBuf::from("/usr/local/bin/code"),
        PathBuf::from("/opt/homebrew/bin/code"),
    ];

    match editor.trim().to_ascii_lowercase().as_str() {
        "cursor" => pick("cursor", cursor_path, &cursor_fallbacks)
            .map(|p| (p, "Cursor"))
            .ok_or_else(|| crate::AppError::msg("Cursor was not found. Install it or set PATH.")),
        "vscode" | "code" => pick("code", vscode_path, &vscode_fallbacks)
            .map(|p| (p, "VS Code"))
            .ok_or_else(|| crate::AppError::msg("VS Code was not found. Install it or set PATH.")),
        "auto" | "" => {
            if let Some(p) = pick("cursor", cursor_path, &cursor_fallbacks) {
                Ok((p, "Cursor"))
            } else if let Some(p) = pick("code", vscode_path, &vscode_fallbacks) {
                Ok((p, "VS Code"))
            } else {
                Err(crate::AppError::msg(
                    "Neither Cursor nor VS Code was found. Set a preferred editor in Settings → Tools.",
                ))
            }
        }
        other => Err(crate::AppError::msg(format!("Unknown editor: {other}"))),
    }
}

fn dirs_home() -> String {
    std::env::var("HOME").unwrap_or_default()
}

#[command]
pub fn get_conflict_sides(input: ConflictFileInput) -> AppResult<ConflictSidesOutput> {
    git_cli::with_repo_lock(&PathBuf::from(&input.path), |path| {
        let rel = normalize_repo_rel(&input.file_path)?;
        let (has_base, base) = stage_blob(path, 1, &rel);
        let (has_ours, ours) = stage_blob(path, 2, &rel);
        let (has_theirs, theirs) = stage_blob(path, 3, &rel);
        let working = read_working(path, &rel);
        let binary =
            looks_binary(&base) || looks_binary(&ours) || looks_binary(&theirs) || looks_binary(&working);
        let unmerged = path_is_unmerged(path, &rel);
        let has_markers = !binary && working_has_markers(&working);
        Ok(ConflictSidesOutput {
            path: rel,
            base: if binary { String::new() } else { base },
            ours: if binary { String::new() } else { ours },
            theirs: if binary { String::new() } else { theirs },
            working: if binary { String::new() } else { working },
            has_base,
            has_ours,
            has_theirs,
            binary,
            unmerged,
            has_markers,
        })
    })
}

#[command]
pub fn resolve_conflict_file(input: ResolveConflictInput) -> AppResult<MutationOutput> {
    git_cli::with_repo_lock(&PathBuf::from(&input.path), |path| {
        let rel = normalize_repo_rel(&input.file_path)?;
        let target = path.join(&rel);
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|e| {
                crate::AppError::msg(format!("Could not create parent directories: {e}"))
            })?;
        }
        fs::write(&target, input.content.as_bytes())
            .map_err(|e| crate::AppError::msg(format!("Could not write resolved file: {e}")))?;
        match git_cli::run_git(path, &["add", "--", &rel]) {
            Ok(_) => Ok(MutationOutput {
                ok: true,
                message: format!("Resolved {rel}"),
            }),
            Err(e) => Ok(MutationOutput {
                ok: false,
                message: e.to_string(),
            }),
        }
    })
}

#[command]
pub fn open_conflict_in_ide(input: OpenConflictInIdeInput) -> AppResult<MutationOutput> {
    let repo = PathBuf::from(&input.path);
    let rel = normalize_repo_rel(&input.file_path)?;
    let (bin, label) = resolve_ide_bin(
        &input.editor,
        input.cursor_path.as_deref(),
        input.vscode_path.as_deref(),
    )?;
    let mode = input
        .mode
        .as_deref()
        .unwrap_or("file")
        .trim()
        .to_ascii_lowercase();
    // Never block Branchline on the IDE. Cursor --wait especially can freeze the machine
    // when Cursor is already open (nested window + wait for close).
    let abs = repo.join(&rel);
    if !abs.exists() {
        let (_, ours) = stage_blob(&repo, 2, &rel);
        let (_, theirs) = stage_blob(&repo, 3, &rel);
        let content = if !ours.is_empty() { ours } else { theirs };
        if let Some(parent) = abs.parent() {
            let _ = fs::create_dir_all(parent);
        }
        let _ = fs::write(&abs, content.as_bytes());
    }

    if mode == "merge" {
        let (has_base, base) = stage_blob(&repo, 1, &rel);
        let (has_ours, ours) = stage_blob(&repo, 2, &rel);
        let (has_theirs, theirs) = stage_blob(&repo, 3, &rel);
        if looks_binary(&base) || looks_binary(&ours) || looks_binary(&theirs) {
            return Ok(MutationOutput {
                ok: false,
                message: "Binary conflicts need Take yours/theirs or an external merge tool".into(),
            });
        }
        let tmp = std::env::temp_dir().join(format!(
            "branchline-merge-{}",
            std::process::id()
        ));
        fs::create_dir_all(&tmp).map_err(|e| {
            crate::AppError::msg(format!("Could not create temp merge folder: {e}"))
        })?;
        let safe = rel.replace('/', "__");
        let base_path = tmp.join(format!("{safe}.base"));
        let ours_path = tmp.join(format!("{safe}.ours"));
        let theirs_path = tmp.join(format!("{safe}.theirs"));
        fs::write(&base_path, if has_base { base.as_bytes() } else { b"" }).map_err(|e| {
            crate::AppError::msg(format!("Could not write base side: {e}"))
        })?;
        fs::write(&ours_path, if has_ours { ours.as_bytes() } else { b"" }).map_err(|e| {
            crate::AppError::msg(format!("Could not write ours side: {e}"))
        })?;
        fs::write(&theirs_path, if has_theirs { theirs.as_bytes() } else { b"" }).map_err(|e| {
            crate::AppError::msg(format!("Could not write theirs side: {e}"))
        })?;

        let mut cmd = Command::new(&bin);
        cmd.arg("--merge")
            .arg(&ours_path)
            .arg(&theirs_path)
            .arg(&base_path)
            .arg(&abs);
        return Ok(spawn_ide(cmd, &rel, label));
    }

    let mut cmd = Command::new(&bin);
    cmd.arg(&abs);
    Ok(spawn_ide(cmd, &rel, label))
}

fn spawn_ide(mut cmd: Command, rel: &str, label: &str) -> MutationOutput {
    cmd.stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    match cmd.spawn() {
        Ok(_) => MutationOutput {
            ok: true,
            message: format!(
                "Opened {rel} in {label}. Save there, then return here to Stage / Continue."
            ),
        },
        Err(e) => MutationOutput {
            ok: false,
            message: format!("Could not launch {label}: {e}"),
        },
    }
}
