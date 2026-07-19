use crate::infrastructure::git_cli;
use crate::AppResult;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::command;

use super::branch::MutationOutput;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReflogEntry {
    pub index: i32,
    pub sha: String,
    pub short_sha: String,
    pub selector: String,
    pub action: String,
    pub subject: String,
    pub timestamp: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReflogInput {
    pub path: String,
    pub limit: Option<i32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SquashInput {
    pub path: String,
    pub count: i32,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunGitInput {
    pub path: String,
    pub args: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunGitOutput {
    pub ok: bool,
    pub stdout: String,
    pub stderr: String,
}

const ALLOWED_CONSOLE_COMMANDS: &[&str] = &[
    "status",
    "log",
    "diff",
    "show",
    "branch",
    "tag",
    "remote",
    "stash",
    "reflog",
    "rev-parse",
    "ls-files",
    "shortlog",
    "describe",
    "version",
    "help",
    "blame",
];

const BLOCKED_ARG_PREFIXES: &[&str] = &[
    "-c",
    "--exec-path",
    "--git-dir",
    "--work-tree",
    "--namespace",
    "--upload-pack",
    "--receive-pack",
    "--ext-diff",
    "--html-path",
    "--man-path",
    "--info-path",
    "--super-prefix",
    "--literal-pathspecs",
    "--glob-pathspecs",
    "--noglob-pathspecs",
    "--icase-pathspecs",
];

fn args_are_safe(args: &[String]) -> Result<(), String> {
    if args.is_empty() {
        return Err("No command provided".into());
    }
    let cmd = args[0].as_str();
    if cmd.starts_with('-') {
        return Err("Global git options are not allowed in console".into());
    }
    if !ALLOWED_CONSOLE_COMMANDS.contains(&cmd) {
        return Err(format!(
            "Command '{cmd}' is not allowed in console. Allowed: {}",
            ALLOWED_CONSOLE_COMMANDS.join(", ")
        ));
    }
    for arg in &args[1..] {
        let lower = arg.to_ascii_lowercase();
        if BLOCKED_ARG_PREFIXES
            .iter()
            .any(|p| lower == *p || lower.starts_with(&format!("{p}=")))
        {
            return Err(format!("Argument '{arg}' is not allowed"));
        }
        if lower.starts_with("--config=") || lower == "--config" {
            return Err("Config overrides are not allowed".into());
        }
    }
    if cmd == "stash"
        && args
            .iter()
            .any(|a| matches!(a.as_str(), "drop" | "clear" | "pop"))
    {
        return Err("Destructive stash mutations are not allowed from console".into());
    }
    if cmd == "branch"
        && args
            .iter()
            .any(|a| a == "-D" || a == "-d" || a == "--delete" || a == "-m" || a == "--move")
    {
        return Err(
            "Branch mutations are not allowed from console — use Branchline actions".into(),
        );
    }
    if cmd == "tag" && args.iter().any(|a| a == "-d" || a == "--delete") {
        return Err("Tag deletion is not allowed from console — use Branchline actions".into());
    }
    Ok(())
}

#[command]
pub fn list_reflog(input: ReflogInput) -> AppResult<Vec<ReflogEntry>> {
    git_cli::with_repo_lock(&PathBuf::from(&input.path), |path| {
        let limit = input.limit.unwrap_or(80).clamp(1, 500).to_string();
        let (ok, out, _) = git_cli::run_git_allow_fail(
            path,
            &[
                "reflog",
                "--date=unix",
                &format!("-n{limit}"),
                "--pretty=format:%H|%h|%gd|%gs|%ct",
            ],
        );
        if !ok || out.trim().is_empty() {
            return Ok(vec![]);
        }

        let mut entries = Vec::new();
        for (i, line) in out.lines().enumerate() {
            let parts: Vec<&str> = line.splitn(5, '|').collect();
            if parts.len() < 5 {
                continue;
            }
            let gs = parts[3].trim();
            let (action, subject) = if let Some((a, s)) = gs.split_once(": ") {
                (a.to_string(), s.to_string())
            } else {
                (gs.to_string(), String::new())
            };
            let timestamp = parts[4].trim().parse::<i64>().unwrap_or(0);
            entries.push(ReflogEntry {
                index: i as i32,
                sha: parts[0].trim().to_string(),
                short_sha: parts[1].trim().to_string(),
                selector: parts[2].trim().to_string(),
                action,
                subject,
                timestamp,
            });
        }
        Ok(entries)
    })
}

#[command]
pub fn squash_commits(input: SquashInput) -> AppResult<MutationOutput> {
    git_cli::with_repo_lock(&PathBuf::from(&input.path), |path| {
        let count = input.count.clamp(2, 50);
        let message = input.message.trim();
        if message.is_empty() {
            return Ok(MutationOutput {
                ok: false,
                message: "Squash commit message is required".into(),
            });
        }

        let status = git_cli::run_git(path, &["status", "--porcelain"])?;
        if !status.trim().is_empty() {
            return Ok(MutationOutput {
                ok: false,
                message: "Working tree must be clean before squashing".into(),
            });
        }

        let target = format!("HEAD~{count}");
        git_cli::run_git(path, &["reset", "--soft", &target])?;
        git_cli::run_git(path, &["commit", "-m", message])?;
        Ok(MutationOutput {
            ok: true,
            message: format!("Squashed {count} commits"),
        })
    })
}

#[command]
pub fn run_git_command(input: RunGitInput) -> AppResult<RunGitOutput> {
    git_cli::with_repo_lock(&PathBuf::from(&input.path), |path| {
        if let Err(stderr) = args_are_safe(&input.args) {
            return Ok(RunGitOutput {
                ok: false,
                stdout: String::new(),
                stderr,
            });
        }
        let args: Vec<&str> = input.args.iter().map(|s| s.as_str()).collect();
        let (ok, stdout, stderr) = git_cli::run_git_allow_fail(path, &args);
        Ok(RunGitOutput { ok, stdout, stderr })
    })
}
