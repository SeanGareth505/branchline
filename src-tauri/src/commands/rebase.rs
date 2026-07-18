use crate::infrastructure::git_cli;
use crate::AppResult;
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use tauri::command;

use super::branch::MutationOutput;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RebaseCommitInfo {
    pub sha: String,
    pub short_sha: String,
    pub subject: String,
    pub author: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RebasePreviewInput {
    pub path: String,
    pub onto: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RebasePreview {
    pub onto: String,
    pub onto_short: String,
    pub commits: Vec<RebaseCommitInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RebaseStepInput {
    pub sha: String,
    pub action: String,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InteractiveRebaseInput {
    pub path: String,
    pub onto: String,
    pub steps: Vec<RebaseStepInput>,
}

fn normalize_action(action: &str) -> Option<&'static str> {
    match action.trim().to_ascii_lowercase().as_str() {
        "pick" | "p" => Some("pick"),
        "reword" | "r" => Some("reword"),
        "edit" | "e" => Some("edit"),
        "squash" | "s" => Some("squash"),
        "fixup" | "f" => Some("fixup"),
        "drop" | "d" => Some("drop"),
        _ => None,
    }
}

fn short_sha(sha: &str) -> String {
    sha.chars().take(7).collect()
}

fn write_executable(path: &Path, contents: &str) -> AppResult<()> {
    fs::write(path, contents).map_err(|e| crate::AppError::msg(format!("Failed to write helper: {e}")))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = fs::metadata(path)
            .map_err(|e| crate::AppError::msg(e.to_string()))?
            .permissions();
        perms.set_mode(0o755);
        fs::set_permissions(path, perms).map_err(|e| crate::AppError::msg(e.to_string()))?;
    }
    Ok(())
}

#[command]
pub fn preview_interactive_rebase(input: RebasePreviewInput) -> AppResult<RebasePreview> {
    git_cli::with_repo_lock(&PathBuf::from(&input.path), |path| {
        let onto = input.onto.trim();
        if onto.is_empty() {
            return Err(crate::AppError::msg("Rebase base commit is required"));
        }

        let (ok, onto_full, err) = git_cli::run_git_allow_fail(path, &["rev-parse", onto]);
        if !ok {
            return Err(crate::AppError::git(if err.trim().is_empty() {
                format!("Unknown rebase base: {onto}")
            } else {
                err.trim().to_string()
            }));
        }
        let onto_full = onto_full.trim().to_string();

        let range = format!("{onto_full}..HEAD");
        let (ok, out, _) = git_cli::run_git_allow_fail(
            path,
            &["log", "--reverse", "--pretty=format:%H|%h|%s|%an", &range],
        );
        if !ok {
            return Ok(RebasePreview {
                onto: onto_full.clone(),
                onto_short: short_sha(&onto_full),
                commits: vec![],
            });
        }

        let mut commits = Vec::new();
        for line in out.lines() {
            let parts: Vec<&str> = line.splitn(4, '|').collect();
            if parts.len() < 4 {
                continue;
            }
            commits.push(RebaseCommitInfo {
                sha: parts[0].trim().to_string(),
                short_sha: parts[1].trim().to_string(),
                subject: parts[2].trim().to_string(),
                author: parts[3].trim().to_string(),
            });
        }

        Ok(RebasePreview {
            onto: onto_full.clone(),
            onto_short: short_sha(&onto_full),
            commits,
        })
    })
}

#[command]
pub fn start_interactive_rebase(input: InteractiveRebaseInput) -> AppResult<MutationOutput> {
    git_cli::with_repo_lock(&PathBuf::from(&input.path), |path| {
        let onto = input.onto.trim();
        if onto.is_empty() {
            return Ok(MutationOutput {
                ok: false,
                message: "Rebase base commit is required".into(),
            });
        }
        if input.steps.is_empty() {
            return Ok(MutationOutput {
                ok: false,
                message: "No commits to rebase".into(),
            });
        }

        let status = git_cli::run_git(path, &["status", "--porcelain"])?;
        if !status.trim().is_empty() {
            return Ok(MutationOutput {
                ok: false,
                message: "Working tree must be clean before interactive rebase".into(),
            });
        }

        let (ok, onto_full, err) = git_cli::run_git_allow_fail(path, &["rev-parse", onto]);
        if !ok {
            return Ok(MutationOutput {
                ok: false,
                message: if err.trim().is_empty() {
                    format!("Unknown rebase base: {onto}")
                } else {
                    err.trim().to_string()
                },
            });
        }
        let onto_full = onto_full.trim().to_string();

        let mut todo_lines: Vec<String> = Vec::new();
        let mut reword_count = 0usize;
        let mut has_edit = false;
        let mut kept = 0usize;

        let tmp = std::env::temp_dir().join(format!(
            "branchline-rebase-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).map_err(|e| crate::AppError::msg(e.to_string()))?;
        let messages_dir = tmp.join("messages");
        fs::create_dir_all(&messages_dir).map_err(|e| crate::AppError::msg(e.to_string()))?;

        for step in &input.steps {
            let Some(action) = normalize_action(&step.action) else {
                return Ok(MutationOutput {
                    ok: false,
                    message: format!("Unknown rebase action: {}", step.action),
                });
            };
            if action == "drop" {
                continue;
            }

            let (ok, full, _) = git_cli::run_git_allow_fail(path, &["rev-parse", &step.sha]);
            if !ok {
                return Ok(MutationOutput {
                    ok: false,
                    message: format!("Unknown commit: {}", step.sha),
                });
            }
            let full = full.trim().to_string();
            let subject = git_cli::run_git(path, &["log", "-1", "--pretty=format:%s", &full])
                .unwrap_or_else(|_| String::new());

            if action == "reword" {
                reword_count += 1;
                let msg = step
                    .message
                    .as_deref()
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .unwrap_or(subject.as_str());
                let msg_path = messages_dir.join(&full);
                let mut file = fs::File::create(&msg_path)
                    .map_err(|e| crate::AppError::msg(format!("Failed to write reword message: {e}")))?;
                writeln!(file, "{msg}")
                    .map_err(|e| crate::AppError::msg(format!("Failed to write reword message: {e}")))?;
            }
            if action == "edit" {
                has_edit = true;
            }

            todo_lines.push(format!("{action} {full} {subject}"));
            kept += 1;
        }

        if kept == 0 {
            let _ = fs::remove_dir_all(&tmp);
            return Ok(MutationOutput {
                ok: false,
                message: "All commits were marked drop — nothing to rebase".into(),
            });
        }

        let todo_path = tmp.join("git-rebase-todo");
        fs::write(&todo_path, format!("{}\n", todo_lines.join("\n")))
            .map_err(|e| crate::AppError::msg(format!("Failed to write rebase todo: {e}")))?;

        let seq_editor = tmp.join("sequence-editor.sh");
        write_executable(
            &seq_editor,
            &format!(
                "#!/bin/sh\ncp \"{}\" \"$1\"\n",
                todo_path.to_string_lossy().replace('"', "\\\"")
            ),
        )?;

        let msg_editor = tmp.join("message-editor.sh");
        write_executable(
            &msg_editor,
            &format!(
                r#"#!/bin/sh
REPO="{repo}"
MSG_DIR="{msg_dir}"
TARGET="$1"
SHA=$(git -C "$REPO" rev-parse -q --verify REBASE_HEAD 2>/dev/null || true)
if [ -n "$SHA" ] && [ -f "$MSG_DIR/$SHA" ]; then
  cp "$MSG_DIR/$SHA" "$TARGET"
  exit 0
fi
exit 0
"#,
                repo = path.to_string_lossy().replace('"', "\\\""),
                msg_dir = messages_dir.to_string_lossy().replace('"', "\\\"")
            ),
        )?;

        let bin = git_cli::git_bin()?;
        let output = Command::new(&bin)
            .args(["rebase", "-i", &onto_full])
            .current_dir(path)
            .env("GIT_SEQUENCE_EDITOR", &seq_editor)
            .env("GIT_EDITOR", &msg_editor)
            .env("EDITOR", &msg_editor)
            .env("VISUAL", &msg_editor)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .output()
            .map_err(|e| crate::AppError::git(format!("Failed to run interactive rebase: {e}")))?;

        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let combined = if !stderr.is_empty() { stderr } else { stdout };

        let rebase_in_progress = path.join(".git/rebase-merge").exists()
            || path.join(".git/rebase-apply").exists();

        if output.status.success() && !rebase_in_progress {
            let _ = fs::remove_dir_all(&tmp);
            return Ok(MutationOutput {
                ok: true,
                message: if combined.is_empty() {
                    format!("Interactive rebase onto {}", short_sha(&onto_full))
                } else {
                    combined
                },
            });
        }

        let lower = combined.to_ascii_lowercase();
        if rebase_in_progress
            || lower.contains("conflict")
            || lower.contains("could not apply")
            || lower.contains("you can amend")
            || has_edit
            || reword_count > 0 && rebase_in_progress
        {
            return Ok(MutationOutput {
                ok: false,
                message: if combined.is_empty() {
                    "Interactive rebase paused — resolve conflicts or continue".into()
                } else {
                    format!("Interactive rebase paused. {combined}")
                },
            });
        }

        let _ = fs::remove_dir_all(&tmp);
        Ok(MutationOutput {
            ok: false,
            message: if combined.is_empty() {
                "Interactive rebase failed".into()
            } else {
                combined
            },
        })
    })
}
